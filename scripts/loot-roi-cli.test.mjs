import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const runner = fileURLToPath(new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url));
const script = fileURLToPath(new URL("./benchmark-loot-roi.mjs", import.meta.url));
const capture = {
    version: 1,
    sourceDimensions: { width: 3440, height: 1440 },
    uiScalePercent: 80,
    targetFps: 8,
};

test.each([
    ["version", { version: 2 }],
    ["resolution", { sourceDimensions: { width: 1920, height: 1080 } }],
    ["UI scale", { uiScalePercent: 90 }],
    ["sample rate", { targetFps: 30 }],
])("ROI replay rejects unsupported %s before decoding", async (_name, change) => {
    const root = await mkdtemp(join(tmpdir(), "loot-roi-test-"));
    try {
        const id = "run-1-1-0001";
        await mkdir(join(root, id));
        await writeFile(
            join(root, "annotations.json"),
            JSON.stringify({ version: 1, itemDictionary: ["Gold Bar 1G"], runs: [{ id, split: "development" }] }),
        );
        await writeFile(join(root, id, "manifest.json"), JSON.stringify({ ...capture, ...change }));
        await expect(exec(process.execPath, [runner, "--script", script, root])).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining("unsupported capture profile"),
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;
test.skipIf(!ffmpegAvailable).each([
    [3440, false, 80],
    [2560, false, 80],
    [3440, true, 80],
    [2560, true, 80],
    [3440, true, 100],
    [2560, true, 100],
])("replays %ix1440 crops (external: %s, scale: %i)", async (width, externalLabels, uiScalePercent) => {
    const root = await mkdtemp(join(tmpdir(), "loot-roi-test-"));
    try {
        const id = "run-1-1-0001";
        const manifest = { ...capture, uiScalePercent, sourceDimensions: { width, height: 1440 } };
        for (const [kind, cropWidth, cropHeight] of [
            ["normal", uiScalePercent === 80 ? 362 : 453, uiScalePercent === 80 ? 311 : 389],
            ["rare", uiScalePercent === 80 ? 400 : 500, uiScalePercent === 80 ? 100 : 125],
        ]) {
            const folder = join(root, id, kind, "minute-000");
            await mkdir(folder, { recursive: true });
            await exec("ffmpeg", [
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                `color=black:s=${cropWidth}x${cropHeight},format=rgb24`,
                "-frames:v",
                "1",
                "-threads",
                "1",
                join(folder, "frame-000001.png"),
            ]);
            manifest[`${kind}Crop`] = { pixels: { width: cropWidth, height: cropHeight } };
        }
        await writeFile(join(root, id, "manifest.json"), JSON.stringify(manifest));
        const labelsPath = join(root, externalLabels ? "reviewed labels.json" : "annotations.json");
        const labels = {
            version: 1,
            itemDictionary: ["Gold Bar 1G"],
            runs: [
                {
                    id,
                    split: "development",
                    normalCases: [{ id: "empty-crop", firstBatchId: 1, lastBatchId: 1, events: [] }],
                },
            ],
        };
        await writeFile(labelsPath, JSON.stringify(labels));
        const args = [runner, "--script", script, root, ...(externalLabels ? ["--annotations", labelsPath] : [])];
        const { stdout } = await exec(process.execPath, args);
        expect(
            stdout
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line)),
        ).toEqual([
            expect.objectContaining({
                run: id,
                kind: "normal",
                frames: 1,
                candidates: 0,
                ocrJobs: 0,
                reviewedCases: [{ id: "empty-crop", expected: 0, matched: 0, missed: 0, extra: 0 }],
            }),
            expect.objectContaining({ run: id, kind: "rare", frames: 1, candidates: 0, ocrJobs: 0 }),
        ]);
        labels.runs[0].normalCases[0].events.push({ firstBatchId: 1, item: "Gold Bar 1G", quantity: 1 });
        await writeFile(labelsPath, JSON.stringify(labels));
        await expect(exec(process.execPath, args)).rejects.toMatchObject({
            code: 1,
            stdout: expect.stringContaining('"expected":1,"matched":0,"missed":1,"extra":0'),
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
