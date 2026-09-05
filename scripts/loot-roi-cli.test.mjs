import { execFile } from "node:child_process";
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
    ["UI scale", { uiScalePercent: 100 }],
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
