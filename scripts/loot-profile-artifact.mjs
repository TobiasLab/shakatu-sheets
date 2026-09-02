import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateLiveLootProfileArtifact } from "../src/recognition/liveLootProfile.ts";

export const LOOT_E2E_USAGE =
    "Usage: npm run benchmark:loot:e2e -- <generated-manifest.json> [--development-only] [--debug] [--profile-output <path>]";

export function parseLootE2eArguments(arguments_, workingDirectory = process.cwd()) {
    let manifest;
    let profileOutput;
    let developmentOnly = false;
    let debug = false;
    let help = false;
    let sawProfileOutput = false;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--profile-output") {
            if (sawProfileOutput) throw new Error("--profile-output may be specified only once.");
            sawProfileOutput = true;
            const output = arguments_[index + 1];
            if (output === undefined || output.startsWith("-")) {
                throw new Error("--profile-output requires a path.");
            }
            profileOutput = resolve(workingDirectory, output);
            index += 1;
        } else if (argument === "--development-only") {
            if (developmentOnly) throw new Error("--development-only may be specified only once.");
            developmentOnly = true;
        } else if (argument === "--debug") {
            if (debug) throw new Error("--debug may be specified only once.");
            debug = true;
        } else if (argument === "--help") {
            if (help) throw new Error("--help may be specified only once.");
            help = true;
        } else if (argument.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}.`);
        } else if (manifest !== undefined) {
            throw new Error(`Unexpected extra positional argument: ${argument}.`);
        } else {
            manifest = resolve(workingDirectory, argument);
        }
    }

    if (!help && manifest === undefined) throw new Error("A generated manifest path is required.");
    if (profileOutput !== undefined && manifest === profileOutput) {
        throw new Error("--profile-output must not overwrite the input manifest.");
    }
    if (profileOutput !== undefined && developmentOnly) {
        throw new Error("--profile-output cannot be used with --development-only.");
    }
    return { manifestPath: manifest, profileOutput, developmentOnly, debug, help };
}

export function createLootProfileArtifact(manifest, profile) {
    const display = manifest.display;
    const recording = manifest.recording;
    if (display?.width !== recording?.width || display?.height !== recording?.height) {
        throw new Error("Profile export requires display dimensions to equal recording dimensions.");
    }
    return validateLiveLootProfileArtifact({
        version: 1,
        capture: {
            sourceWidth: recording?.width,
            sourceHeight: recording?.height,
            uiScalePercent: manifest.uiScalePercent,
            sampleFps: manifest.sampleFps,
        },
        profile,
    });
}

async function canonicalPath(path) {
    try {
        return await realpath(path);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = dirname(path);
        if (parent === path) return path;
        return join(await canonicalPath(parent), basename(path));
    }
}

export async function assertDistinctLootProfileOutput(manifestPath, outputPath) {
    if (outputPath === undefined) return;
    if ((await canonicalPath(manifestPath)) === (await canonicalPath(outputPath))) {
        throw new Error("--profile-output must not overwrite the input manifest.");
    }
}

export function assertLootProfileExportEligible(results) {
    const heldOut = results.filter((result) => result.split !== "development");
    const eventCount = heldOut.reduce((count, result) => count + result.expectedCount, 0);
    if (eventCount === 0) {
        throw new Error("Profile export requires at least one non-baseline validation or test event.");
    }
    const failed = heldOut.find(
        (result) =>
            result.matchedCount !== result.expectedCount ||
            result.correctCount !== result.expectedCount ||
            result.missedCount !== 0 ||
            result.inventedCount !== 0,
    );
    if (failed) {
        throw new Error(`Profile export requires exact held-out detection and recognition; ${failed.id} did not pass.`);
    }
}

export async function writeLootProfileArtifactAtomic(
    outputPath,
    artifact,
    { protectedInputPath, fileSystem = { mkdir, open, realpath, rename, unlink } } = {},
) {
    const validated = validateLiveLootProfileArtifact(artifact);
    const contents = `${JSON.stringify(validated, null, 4)}\n`;
    await fileSystem.mkdir(dirname(outputPath), { recursive: true });
    const outputDirectory = await fileSystem.realpath(dirname(outputPath));
    const canonicalOutputPath = resolve(outputDirectory, basename(outputPath));
    if (protectedInputPath !== undefined) {
        await assertDistinctLootProfileOutput(protectedInputPath, canonicalOutputPath);
    }
    const temporaryPath = resolve(
        outputDirectory,
        `.${basename(canonicalOutputPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    let closed = false;
    let failure;
    try {
        handle = await fileSystem.open(temporaryPath, "wx");
        await handle.writeFile(contents, "utf8");
        await handle.sync();
        await handle.close();
        closed = true;
        await fileSystem.rename(temporaryPath, canonicalOutputPath);
    } catch (error) {
        failure = error;
    }
    if (handle && !closed) {
        try {
            await handle.close();
        } catch (error) {
            failure ??= error;
        }
    }
    try {
        await fileSystem.unlink(temporaryPath);
    } catch (error) {
        if (error?.code !== "ENOENT") failure ??= error;
    }
    if (failure) throw failure;
}
