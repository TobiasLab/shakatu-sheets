import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { decodeRoiFrames } from "./loot-roi-decoder.mjs";

const available = spawnSync("ffmpeg", ["-version"]).status === 0;
const directories = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function sampleRun() {
    const directory = await mkdtemp(join(tmpdir(), "Shakatu ROI é "));
    directories.push(directory);
    // PPM avoids codec-dependent color conversion when generating exact RGB PNG fixtures.
    // Name order would put minute-100 before minute-99.
    for (const [minute, id, rgb] of [
        [100, 2, [4, 5, 6]],
        [99, 1, [1, 2, 3]],
    ]) {
        const folder = join(directory, `minute-${minute}`);
        await mkdir(folder);
        const png = spawnSync(
            "ffmpeg",
            [
                "-v",
                "error",
                "-f",
                "image2pipe",
                "-i",
                "pipe:0",
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-c:v",
                "png",
                "pipe:1",
            ],
            {
                input: Buffer.concat([Buffer.from("P6\n1 1\n255\n"), Buffer.from(rgb)]),
            },
        );
        expect(png.status, String(png.stderr)).toBe(0);
        await writeFile(join(folder, `frame-${String(id).padStart(6, "0")}.png`), png.stdout);
    }
    return directory;
}
it.skipIf(!available)("streams PNGs in numeric folder order across paths with spaces and Unicode", async () => {
    const directory = await sampleRun();
    const frames = [];
    for await (const frame of decodeRoiFrames(directory, 1, 1, 2)) frames.push([...frame.pixels]);
    expect(frames).toEqual([
        [1, 2, 3, 255],
        [4, 5, 6, 255],
    ]);
});
it.skipIf(!available)("rejects incomplete replay and tears down an early-terminated decoder", async () => {
    const directory = await sampleRun();
    await expect(async () => {
        for await (const _frame of decodeRoiFrames(directory, 1, 1, 3)) {
            /* consume the truncated sequence */
        }
    }).rejects.toThrow("Expected 3 complete frames; decoded 2.");
    const iterator = decodeRoiFrames(directory, 1, 1, 2);
    expect((await iterator.next()).done).toBe(false);
    await iterator.return();
});
