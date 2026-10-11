import { execFile, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    ["resolution", { sourceDimensions: { width: 1280, height: 720 } }],
    ["UI scale", { uiScalePercent: 90 }],
    ["sample rate", { targetFps: 30 }],
    ["font", { font: "unknown" }, "invalid font"],
])(
    "ROI replay rejects unsupported %s before decoding",
    async (_name, change, errorMessage = "unsupported capture profile") => {
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
                stderr: expect.stringContaining(errorMessage),
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;
test.skipIf(!ffmpegAvailable).each([
    [2560, true, 80, 8, true],
    [2560, true, 100, 8, true],
    [3440, false, 80, 8],
    [3440, false, 80, 16],
    [2560, true, 100, 16],
    [2560, false, 80],
    [3440, true, 80],
    [2560, true, 80],
    [3440, true, 100],
    [2560, true, 100],
])(
    "replays %ix1440 crops (external: %s, scale: %i)",
    async (width, externalLabels, uiScalePercent, targetFps = 8, compact = false) => {
        const root = await mkdtemp(join(tmpdir(), "loot-roi-test-"));
        try {
            const id = "run-1-1-0001";
            const manifest = { ...capture, targetFps, uiScalePercent, sourceDimensions: { width, height: 1440 } };
            for (let [kind, cropWidth, cropHeight] of [
                ["normal", uiScalePercent === 80 ? 362 : 453, uiScalePercent === 80 ? 311 : 389],
                ["rare", uiScalePercent === 80 ? 400 : 500, uiScalePercent === 80 ? 100 : 125],
            ]) {
                if (compact) {
                    [cropWidth, cropHeight] =
                        kind === "normal"
                            ? uiScalePercent === 80
                                ? [272, 180]
                                : [341, 226]
                            : uiScalePercent === 80
                              ? [340, 72]
                              : [425, 90];
                }
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
            if (width === 3440 && uiScalePercent === 80 && !externalLabels) {
                for (const kind of ["normal", "rare"]) {
                    const folder = join(root, id, kind, "minute-000");
                    await copyFile(join(folder, "frame-000001.png"), join(folder, "frame-000002.png"));
                }
                const sampled = await exec(process.execPath, [...args, "--sample-step", "2", "--sample-offset", "1"]);
                expect(sampled.stdout.trim().split("\n").map(JSON.parse)).toEqual([
                    expect.objectContaining({
                        kind: "normal",
                        frames: 1,
                        sourceFrames: 2,
                        sampleStep: 2,
                        sampleOffset: 1,
                    }),
                    expect.objectContaining({
                        kind: "rare",
                        frames: 1,
                        sourceFrames: 2,
                        sampleStep: 2,
                        sampleOffset: 1,
                    }),
                ]);
            }
            if (width === 3440 && uiScalePercent === 80 && !externalLabels) {
                labels.runs[0].expectedResultsSha256 = { normal: "incorrect-baseline" };
                await writeFile(labelsPath, JSON.stringify(labels));
                const detectionOnly = await exec(process.execPath, args);
                expect(detectionOnly.stdout).not.toContain('"matchesBaseline"');
                const sampledOcr = await exec(process.execPath, [...args, "--ocr", "--sample-step", "2"]);
                expect(sampledOcr.stdout).not.toContain('"matchesBaseline"');
                await expect(exec(process.execPath, [...args, "--ocr"])).rejects.toMatchObject({
                    code: 1,
                    stdout: expect.stringContaining('"matchesBaseline":false'),
                });
                delete labels.runs[0].expectedResultsSha256;
            }
            labels.runs[0].normalCases[0].events.push({ firstBatchId: 1, item: "Gold Bar 1G", quantity: 1 });
            await writeFile(labelsPath, JSON.stringify(labels));
            await expect(exec(process.execPath, args)).rejects.toMatchObject({
                code: 1,
                stdout: expect.stringContaining('"expected":1,"matched":0,"missed":1,"extra":0'),
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);

test.each([
    ["0", "0"],
    ["3", "0"],
    ["2", "2"],
    ["2", "-1"],
])("rejects invalid offline sampling step %s and offset %s", async (step, offset) => {
    await expect(
        exec(process.execPath, [
            runner,
            "--script",
            script,
            "/unused",
            `--sample-step=${step}`,
            `--sample-offset=${offset}`,
        ]),
    ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Sampling requires"),
    });
});
