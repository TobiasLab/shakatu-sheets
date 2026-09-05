import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export async function* decodeRoiFrames(directory, width, height, expectedCount) {
    const child = spawn(
        "ffmpeg",
        [
            "-v",
            "error",
            "-threads",
            "1",
            "-f",
            "image2pipe",
            "-framerate",
            "8",
            "-i",
            "pipe:0",
            "-threads",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (chunk) => {
        error = (error + chunk).slice(-4096);
    });
    const completion = new Promise((resolveDecode) => {
        child.on("error", (failure) => resolveDecode(failure));
        child.on("close", (code) => resolveDecode(code === 0 ? null : new Error(`ffmpeg: ${error}`)));
    });
    const feeding = pipeline(async function* () {
        for (const minute of (await readdir(directory)).filter((name) => /^minute-\d+$/.test(name)).sort()) {
            const folder = join(directory, minute);
            for (const name of (await readdir(folder)).filter((name) => /^frame-\d+\.png$/.test(name)).sort()) {
                yield* createReadStream(join(folder, name));
            }
        }
    }, child.stdin);
    void feeding.catch(() => child.kill());
    const frameSize = width * height * 4;
    let buffer = Buffer.alloc(0);
    let count = 0;
    try {
        for await (const chunk of child.stdout) {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= frameSize) {
                // Coordinator takes ownership; don't retain the decoder's larger chunk through a subarray.
                const pixels = new Uint8ClampedArray(buffer.subarray(0, frameSize));
                buffer = buffer.subarray(frameSize);
                count += 1;
                yield { width, height, pixels };
            }
        }
        await feeding;
        const failure = await completion;
        if (failure) throw failure;
        if (buffer.length || count !== expectedCount)
            throw new Error(`Expected ${expectedCount} complete frames; decoded ${count}.`);
    } finally {
        child.stdin.destroy();
        child.kill();
        await Promise.allSettled([feeding, completion]);
    }
}
