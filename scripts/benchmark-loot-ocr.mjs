import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createWorker, OEM, PSM } from "tesseract.js";
import {
    benchmarkEvents,
    calibrateThreshold,
    chooseTemporalConsensus,
    parseItem,
    parseQuantity,
    validateGeneratedManifest,
} from "./loot-benchmark-core.mjs";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const developmentOnly = process.argv.includes("--development-only");
const debug = process.argv.includes("--debug");
if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: npm run benchmark:loot:ocr -- <generated-manifest.json> [--development-only] [--debug]");
    process.exit(manifestPath ? 0 : 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateGeneratedManifest(manifest, { requireItemDictionary: true });
const benchmarkDirectory = dirname(manifestPath);
const width = manifest.roi?.pixels?.width;
const height = manifest.roi?.pixels?.height;
const maxRows = manifest.maxRows;
const itemDictionary = manifest.itemDictionary;

function decodeFrames(segment) {
    return new Promise((resolveDecode, rejectDecode) => {
        const child = spawn(
            "ffmpeg",
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-framerate",
                String(manifest.sampleFps),
                "-i",
                join(benchmarkDirectory, segment.directory, segment.framePattern),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", rejectDecode);
        child.on("close", (code) => {
            if (code !== 0) {
                rejectDecode(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
                return;
            }
            const bytes = Buffer.concat(stdout);
            const frameSize = width * height * 3;
            if (bytes.length !== frameSize * segment.frameCount) {
                rejectDecode(new Error(`${segment.id}: expected ${segment.frameCount} decoded frames.`));
                return;
            }
            resolveDecode(
                Array.from({ length: segment.frameCount }, (_, index) =>
                    bytes.subarray(index * frameSize, (index + 1) * frameSize),
                ),
            );
        });
    });
}

function luminance(frame, offset) {
    return (frame[offset] * 77 + frame[offset + 1] * 150 + frame[offset + 2] * 29) >> 8;
}

function rowScore(frame, centerY) {
    let score = 0;
    const left = Math.round(width * 0.22);
    const right = Math.round(width * 0.96);
    for (let y = centerY - 6; y <= centerY + 6; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * width + x) * 3;
            const light = luminance(frame, offset);
            const chroma =
                Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
                Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
            const horizontal = Math.min(luminance(frame, offset - 6), luminance(frame, offset + 6));
            const vertical = Math.min(luminance(frame, offset - width * 6), luminance(frame, offset + width * 6));
            if (light >= 115 && chroma <= 55 && light - Math.min(horizontal, vertical) >= 18) score += 1;
        }
    }
    return score;
}

function activeCount(events, frame) {
    return events.filter((event) => event.firstFrame <= frame && event.lastFrame >= frame).length;
}

function calibrateGeometry(trainingSets) {
    const profiledSets = trainingSets.map(({ segment, frames }) => ({
        segment,
        profiles: frames.map((frame) =>
            Array.from({ length: height }, (_, centerY) =>
                centerY >= 8 && centerY < height - 8 ? rowScore(frame, centerY) : 0,
            ),
        ),
    }));
    let best;
    for (let bottomCenter = Math.round(height * 0.58); bottomCenter <= Math.round(height * 0.88); bottomCenter += 1) {
        for (let spacing = Math.round(height * 0.11); spacing <= Math.round(height * 0.18); spacing += 1) {
            if (bottomCenter + 12 > height || bottomCenter - (maxRows - 1) * spacing < 12) continue;
            const examples = [];
            for (const { segment, profiles } of profiledSets) {
                for (let frame = 0; frame < profiles.length; frame += 1) {
                    const count = activeCount(benchmarkEvents(segment), frame);
                    for (let slot = 0; slot < maxRows; slot += 1) {
                        const centerY = bottomCenter - (maxRows - slot - 1) * spacing;
                        examples.push({ score: profiles[frame][centerY], occupied: slot >= maxRows - count });
                    }
                }
            }
            const calibration = calibrateThreshold(examples);
            if (!best || calibration.errors < best.errors) best = { bottomCenter, spacing, ...calibration };
        }
    }
    if (!best) throw new Error("The ROI is too short for the configured maxRows and OCR row geometry.");
    return best;
}

function quantityImage(frame, centerY, threshold) {
    const left = Math.round(width * 0.25);
    const right = Math.round(width * 0.8);
    const top = centerY - 12;
    const bottom = centerY + 12;
    const scale = 4;
    const padding = 10;
    const imageWidth = (right - left) * scale + padding * 2;
    const imageHeight = (bottom - top) * scale + padding * 2;
    const pixels = Buffer.alloc(imageWidth * imageHeight, 255);
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * width + x) * 3;
            const chroma =
                Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
                Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
            if (luminance(frame, offset) < threshold || chroma > 65) continue;
            for (let scaledY = 0; scaledY < scale; scaledY += 1) {
                for (let scaledX = 0; scaledX < scale; scaledX += 1) {
                    const targetX = padding + (x - left) * scale + scaledX;
                    const targetY = padding + (y - top) * scale + scaledY;
                    pixels[targetY * imageWidth + targetX] = 0;
                }
            }
        }
    }
    return Buffer.concat([Buffer.from(`P5\n${imageWidth} ${imageHeight}\n255\n`), pixels]);
}

function rowCenter(segment, event, frame, geometry) {
    const active = benchmarkEvents(segment).filter(
        (candidate) => candidate.firstFrame <= frame && candidate.lastFrame >= frame,
    );
    const index = active.indexOf(event);
    if (index === -1) throw new Error(`${segment.id}/${event.id}: event is not active on frame ${frame}.`);
    return geometry.bottomCenter - (active.length - index - 1) * geometry.spacing;
}

const selectedSegments = manifest.segments.filter((segment) => !developmentOnly || segment.split === "development");
const decoded = [];
for (const segment of selectedSegments) decoded.push({ segment, frames: await decodeFrames(segment) });
const developmentSets = decoded.filter(({ segment }) => segment.split === "development");
if (developmentSets.length === 0) throw new Error("At least one development segment is required.");
const geometry = calibrateGeometry(developmentSets);
console.log(`Development row geometry: bottom ${geometry.bottomCenter}px, spacing ${geometry.spacing}px`);

const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    langPath: resolve("public/ocr"),
    cacheMethod: "none",
    gzip: true,
});
await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
});

let failed = false;
try {
    for (const { segment, frames } of decoded) {
        let correct = 0;
        let accepted = 0;
        let correctItems = 0;
        let acceptedItems = 0;
        let correctEvents = 0;
        const mismatches = [];
        const events = benchmarkEvents(segment).filter((event) => !event.baseline);
        for (const event of events) {
            const frameNumbers = [event.stableFrame, event.stableFrame + 1, event.stableFrame + 2];
            const readingsByFrame = [];
            const itemReadingsByFrame = [];
            const rawReadings = [];
            for (const frameNumber of frameNumbers) {
                const centerY = rowCenter(segment, event, frameNumber, geometry);
                const frameReadings = [];
                const frameItemReadings = [];
                for (const threshold of [130, 150, 170]) {
                    const result = await worker.recognize(quantityImage(frames[frameNumber], centerY, threshold));
                    const text = result.data.text.trim();
                    rawReadings.push(text);
                    frameReadings.push(parseQuantity(text));
                    frameItemReadings.push(parseItem(text, itemDictionary));
                }
                readingsByFrame.push(frameReadings);
                itemReadingsByFrame.push(frameItemReadings);
            }
            const actual = chooseTemporalConsensus(readingsByFrame);
            const actualItem = chooseTemporalConsensus(itemReadingsByFrame);
            if (actual !== "") accepted += 1;
            if (actualItem !== "") acceptedItems += 1;
            if (actual === String(event.quantity)) correct += 1;
            else mismatches.push(`${event.id}: expected ${event.quantity}, got ${actual || "withheld"}`);
            if (actualItem === event.item) correctItems += 1;
            else mismatches.push(`${event.id}: expected ${event.item}, got ${actualItem || "withheld"}`);
            if (actual === String(event.quantity) && actualItem === event.item) correctEvents += 1;
            if (debug) {
                console.log(
                    `${segment.id}/${event.id}: ${actualItem || "withheld"} x ${actual || "withheld"} (${rawReadings.join(" | ")})`,
                );
            }
        }
        const wrong = accepted - correct;
        const wrongItems = acceptedItems - correctItems;
        console.log(`\n${segment.id} (${segment.split})`);
        console.log(
            `Items: ${correctItems}/${events.length} correct, ${wrongItems} wrong, ${events.length - acceptedItems} withheld`,
        );
        console.log(
            `Quantities: ${correct}/${events.length} correct, ${wrong} wrong, ${events.length - accepted} withheld`,
        );
        console.log(`Complete events: ${correctEvents}/${events.length}`);
        if (mismatches.length > 0) console.log(mismatches.join("\n"));
        if (segment.split !== "development" && correctEvents !== events.length) failed = true;
    }
} finally {
    await worker.terminate();
}

if (failed) process.exitCode = 1;
