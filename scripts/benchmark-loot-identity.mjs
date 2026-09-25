import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { analyzeLootRoiFrame, lootFingerprintDistance, lootRowIdentityDistance } from "../src/recognition/liveLoot.ts";
import { preprocessLootOcrFrame } from "../src/recognition/liveLootOcr.ts";
import { findLiveLootProfile } from "../src/recognition/liveLootProfiles.ts";
import { lootGlyphDistance } from "./loot-identity-core.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const directory = args.shift();
if (!directory)
    throw new Error(
        "Usage: vite-node --script scripts/benchmark-loot-identity.mjs <live-loot directory> [--output report.json]",
    );
const root = resolve(directory);
const { values } = parseArgs({ args, options: { output: { type: "string" } } });
const labels = JSON.parse(await readFile(new URL("./fixtures/loot-identity-cases.json", import.meta.url), "utf8"));
if (labels.version !== 1 || labels.split !== "development" || !Array.isArray(labels.cases)) {
    throw new Error("Unsupported quantity identity annotations.");
}
const runs = new Map();
const results = [];
const continuityThreshold = 0.1;

async function source(runId) {
    if (runs.has(runId)) return runs.get(runId);
    if (!/^run-\d+-\d+-\d+$/.test(runId)) throw new Error("Invalid run ID.");
    const folder = join(root, runId);
    const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    const artifact = findLiveLootProfile(
        manifest.sourceDimensions?.width,
        manifest.sourceDimensions?.height,
        manifest.uiScalePercent,
    );
    if (manifest.version !== 1 || !artifact) throw new Error(`${runId}: unsupported capture profile.`);
    const { profile } = artifact;
    const crop = manifest.normalCrop?.pixels;
    if (crop?.width !== profile.width || crop?.height !== profile.height)
        throw new Error(`${runId}: incorrect normal crop.`);
    const files = new Map();
    for (const minute of (await readdir(join(folder, "normal"))).filter((name) => /^minute-\d+$/.test(name))) {
        for (const name of await readdir(join(folder, "normal", minute))) {
            const match = /^frame-(\d+)\.png$/.exec(name);
            if (!match) continue;
            const batchId = Number(match[1]);
            if (files.has(batchId)) throw new Error(`${runId}: duplicate batch ${batchId}.`);
            files.set(batchId, join(folder, "normal", minute, name));
        }
    }
    const run = { profile, files };
    runs.set(runId, run);
    return run;
}

async function readRow(run, label, bounds) {
    const path = run.files.get(label.batchId);
    if (!path) throw new Error(`Missing batch ${label.batchId}.`);
    const { width, height } = run.profile;
    const { stdout } = await exec(
        "ffmpeg",
        ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-threads", "1", "pipe:1"],
        { encoding: "buffer", maxBuffer: width * height * 4 + 1024 },
    );
    const frame = { width, height, pixels: new Uint8ClampedArray(stdout) };
    const rows = analyzeLootRoiFrame(frame, run.profile);
    const observation = rows.observations.find((row) => row.centerY === label.centerY);
    const glyphs = bounds
        ? preprocessLootOcrFrame(
              frame,
              label.centerY,
              150,
              {
                  left: bounds.left,
                  right: bounds.right,
                  top: label.centerY - bounds.halfHeight,
                  bottom: label.centerY + bounds.halfHeight,
              },
              "white",
              2,
              false,
          )
        : null;
    return { fingerprint: observation?.fingerprint, glyphs };
}

for (const test of labels.cases) {
    const run = await source(test.run);
    const left = await readRow(run, test.left, test.quantityBounds);
    const right = await readRow(run, test.right, test.quantityBounds);
    const expectedSame = test.left.quantity === test.right.quantity;
    const baselineDistance =
        left.fingerprint && right.fingerprint ? lootFingerprintDistance(left.fingerprint, right.fingerprint) : null;
    const glyphDistance = left.glyphs && right.glyphs ? lootGlyphDistance(left.glyphs, right.glyphs) : null;
    // OCR preprocessing enlarges by 2×, so this permits one native pixel of vertical alignment.
    const alignedDistance = left.glyphs && right.glyphs ? lootGlyphDistance(left.glyphs, right.glyphs, 2) : null;
    const evaluate = (distance) => ({ distance, correct: distance !== null && distance <= 0.1 === expectedSame });
    results.push({
        id: test.id,
        run: test.run,
        expectedSame,
        baseline: evaluate(baselineDistance),
        automaticDigitCrop: evaluate(
            left.fingerprint && right.fingerprint ? lootRowIdentityDistance(left.fingerprint, right.fingerprint) : null,
        ),
        manualDigitCrop: evaluate(glyphDistance),
        alignedDigitCrop: evaluate(alignedDistance),
    });
}
const report = {
    note: "Development-only quantity-shape experiment. Manually annotated digit bounds are not available to the live tracker. Pair agreement does not establish event tracking accuracy; equal quantities can be separate drops.",
    continuityThreshold,
    cases: results.length,
    baselineCorrect: results.filter((result) => result.baseline.correct).length,
    automaticDigitCropCorrect: results.filter((result) => result.automaticDigitCrop.correct).length,
    manualCases: labels.cases.filter((test) => test.quantityBounds).length,
    manualDigitCropCorrect: results.filter((result) => result.manualDigitCrop.correct).length,
    alignedDigitCropCorrect: results.filter((result) => result.alignedDigitCrop.correct).length,
    results,
};
if (values.output) {
    const output = resolve(values.output);
    const fromRoot = relative(root, output);
    if (!isAbsolute(fromRoot) && fromRoot.split(sep)[0] !== "..")
        throw new Error("Write analysis outside the source corpus.");
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}
console.log(JSON.stringify(report));
