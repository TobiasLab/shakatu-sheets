import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    assertDistinctLootProfileOutput,
    assertLootProfileExportEligible,
    createLootProfileArtifact,
    parseLootE2eArguments,
    writeLootProfileArtifactAtomic,
} from "./loot-profile-artifact.mjs";

const profile = {
    width: 362,
    height: 311,
    maxRows: 5,
    bottomCenter: 291,
    spacing: 40,
    rowThreshold: 100,
};

const manifest = {
    display: { width: 3440, height: 1440 },
    recording: { width: 3440, height: 1440 },
    uiScalePercent: 80,
    sampleFps: 8,
};

describe("loot E2E argument parsing", () => {
    it("parses profile output in either option position", () => {
        const workingDirectory = resolve("work");
        expect(
            parseLootE2eArguments(["manifest.json", "--profile-output", "profiles/live.json"], workingDirectory),
        ).toEqual({
            manifestPath: join(workingDirectory, "manifest.json"),
            profileOutput: join(workingDirectory, "profiles", "live.json"),
            developmentOnly: false,
            debug: false,
            help: false,
        });
        expect(
            parseLootE2eArguments(["--debug", "--profile-output", "profile.json", "manifest.json"], workingDirectory)
                .debug,
        ).toBe(true);
    });

    it("rejects malformed and conflicting arguments", () => {
        expect(() => parseLootE2eArguments(["manifest.json", "--profile-output"])).toThrow(/requires a path/);
        expect(() => parseLootE2eArguments(["manifest.json", "--profile-output", "--unknown"])).toThrow(
            /requires a path/,
        );
        expect(() =>
            parseLootE2eArguments(["manifest.json", "--profile-output", "one", "--profile-output", "two"]),
        ).toThrow(/only once/);
        expect(() => parseLootE2eArguments(["manifest.json", "--unknown"])).toThrow(/Unknown option/);
        expect(() => parseLootE2eArguments(["one.json", "two.json"])).toThrow(/extra positional/);
        expect(() => parseLootE2eArguments(["manifest.json", "--profile-output", "./manifest.json"])).toThrow(
            /input manifest/,
        );
        expect(() =>
            parseLootE2eArguments(["manifest.json", "--development-only", "--profile-output", "profile.json"]),
        ).toThrow(/development-only/);
    });
});

describe("loot profile output safety", () => {
    it("rejects an output path that reaches the manifest through a directory symlink", async () => {
        const directory = await mkdtemp(join(tmpdir(), "loot-profile-"));
        const realDirectory = join(directory, "real");
        const manifestPath = join(realDirectory, "manifest.json");
        try {
            await mkdir(realDirectory);
            const file = await open(manifestPath, "wx");
            await file.close();
            await symlink(realDirectory, join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");

            await expect(
                assertDistinctLootProfileOutput(manifestPath, join(directory, "alias", "manifest.json")),
            ).rejects.toThrow(/input manifest/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("loot profile export gates", () => {
    it("constructs only capture metadata and the profile from equal native dimensions", () => {
        const value = createLootProfileArtifact(
            { ...manifest, source: "/private/video.mp4", itemDictionary: ["Black Stone"], roi: { x: 1 }, label: "run" },
            profile,
        );
        expect(value).toEqual({
            version: 1,
            capture: { sourceWidth: 3440, sourceHeight: 1440, uiScalePercent: 80, sampleFps: 8 },
            profile,
        });
        expect(() =>
            createLootProfileArtifact({ ...manifest, recording: { width: 1920, height: 1080 } }, profile),
        ).toThrow(/display dimensions/);
    });

    it("requires exact held-out results and at least one event", () => {
        const passing = {
            id: "test-segment",
            split: "test",
            expectedCount: 1,
            matchedCount: 1,
            correctCount: 1,
            missedCount: 0,
            inventedCount: 0,
        };
        expect(() => assertLootProfileExportEligible([passing])).not.toThrow();
        expect(() => assertLootProfileExportEligible([{ ...passing, split: "validation" }])).not.toThrow();
        expect(() =>
            assertLootProfileExportEligible([{ ...passing, expectedCount: 0, matchedCount: 0, correctCount: 0 }]),
        ).toThrow(/at least one/);
        for (const failure of [{ correctCount: 0 }, { matchedCount: 0, missedCount: 1 }, { inventedCount: 1 }]) {
            expect(() => assertLootProfileExportEligible([{ ...passing, ...failure }])).toThrow(/exact held-out/);
        }
    });
});

describe("atomic loot profile writing", () => {
    it("atomically replaces an existing file", async () => {
        const directory = await mkdtemp(join(tmpdir(), "loot-profile-"));
        const output = join(directory, "nested", "profile.json");
        try {
            await writeLootProfileArtifactAtomic(output, createLootProfileArtifact(manifest, profile));
            const replacement = createLootProfileArtifact(manifest, { ...profile, rowThreshold: 101 });
            await writeLootProfileArtifactAtomic(output, replacement);
            expect(JSON.parse(await readFile(output, "utf8"))).toEqual(replacement);
            expect(await readdir(join(directory, "nested"))).toEqual(["profile.json"]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("keeps the destination and removes the temporary file when rename fails", async () => {
        const directory = await mkdtemp(join(tmpdir(), "loot-profile-"));
        const output = join(directory, "profile.json");
        const existing = await open(output, "wx");
        await existing.writeFile("existing\n");
        await existing.close();
        try {
            await expect(
                writeLootProfileArtifactAtomic(output, createLootProfileArtifact(manifest, profile), {
                    fileSystem: {
                        mkdir: async () => undefined,
                        open,
                        realpath,
                        rename: async () => {
                            throw new Error("rename failed");
                        },
                        unlink,
                    },
                }),
            ).rejects.toThrow(/rename failed/);
            expect(await readFile(output, "utf8")).toBe("existing\n");
            expect(await readdir(directory)).toEqual(["profile.json"]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("renames within the resolved directory if an output symlink is retargeted", async () => {
        const directory = await mkdtemp(join(tmpdir(), "loot-profile-"));
        const originalDirectory = join(directory, "original");
        const manifestDirectory = join(directory, "manifest");
        const alias = join(directory, "alias");
        const manifestPath = join(manifestDirectory, "profile.json");
        const output = join(alias, "profile.json");
        try {
            await mkdir(originalDirectory);
            await mkdir(manifestDirectory);
            const file = await open(manifestPath, "wx");
            await file.writeFile("manifest\n");
            await file.close();
            const symlinkType = process.platform === "win32" ? "junction" : "dir";
            await symlink(originalDirectory, alias, symlinkType);

            await writeLootProfileArtifactAtomic(output, createLootProfileArtifact(manifest, profile), {
                protectedInputPath: manifestPath,
                fileSystem: {
                    mkdir,
                    open,
                    realpath,
                    rename: async (source, destination) => {
                        await unlink(alias);
                        await symlink(manifestDirectory, alias, symlinkType);
                        await rename(source, destination);
                    },
                    unlink,
                },
            });

            expect(JSON.parse(await readFile(join(originalDirectory, "profile.json"), "utf8"))).toEqual(
                createLootProfileArtifact(manifest, profile),
            );
            expect(await readFile(manifestPath, "utf8")).toBe("manifest\n");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
