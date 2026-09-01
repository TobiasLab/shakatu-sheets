import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createWorker, OEM, PSM } from "tesseract.js";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const developmentOnly = process.argv.includes("--development-only");
const debug = process.argv.includes("--debug");
if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: npm run benchmark:loot:ocr -- <generated-manifest.json> [--development-only] [--debug]");
    process.exit(manifestPath ? 0 : 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const benchmarkDirectory = dirname(manifestPath);
const width = manifest.roi?.pixels?.width;
const height = manifest.roi?.pixels?.height;
const maxRows = manifest.maxRows;
const itemDictionary = manifest.itemDictionary;
if (![width, height, maxRows].every(Number.isInteger) || !Array.isArray(itemDictionary)) {
    throw new Error("The generated manifest must contain ROI dimensions, maxRows, and an itemDictionary.");
}

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
        child.on("exit", (code) => {
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
            const chroma = Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) - Math.min(
                frame[offset],
                frame[offset + 1],
                frame[offset + 2],
            );
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
            if (bottomCenter - (maxRows - 1) * spacing < 8) continue;
            const examples = [];
            for (const { segment, profiles } of profiledSets) {
                for (let frame = 0; frame < profiles.length; frame += 1) {
                    const count = activeCount(segment.events, frame);
                    for (let slot = 0; slot < maxRows; slot += 1) {
                        const centerY = bottomCenter - (maxRows - slot - 1) * spacing;
                        examples.push({ score: profiles[frame][centerY], occupied: slot >= maxRows - count });
                    }
                }
            }
            const candidates = [...new Set(examples.map(({ score }) => score))].sort((left, right) => left - right);
            for (const threshold of candidates) {
                const candidateErrors = examples.filter(({ score, occupied }) => (score >= threshold) !== occupied).length;
                if (!best || candidateErrors < best.errors) best = { bottomCenter, spacing, threshold, errors: candidateErrors };
            }
        }
    }
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
            const chroma = Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) - Math.min(
                frame[offset],
                frame[offset + 1],
                frame[offset + 2],
            );
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
    const active = segment.events.filter((candidate) => candidate.firstFrame <= frame && candidate.lastFrame >= frame);
    const index = active.indexOf(event);
    if (index === -1) throw new Error(`${segment.id}/${event.id}: event is not active on frame ${frame}.`);
    return geometry.bottomCenter - (active.length - index - 1) * geometry.spacing;
}

function chooseQuantity(readings) {
    const counts = new Map();
    for (const reading of readings) {
        if (!/^\d+$/.test(reading) || Number(reading) <= 0) continue;
        counts.set(reading, (counts.get(reading) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
    return ranked[0]?.[1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : "";
}

function parseQuantity(text) {
    const suffix = text.match(/x\s*(\d+|[|Il])\s*$/i)?.[1];
    if (!suffix) return "";
    return /^[|Il]$/i.test(suffix) ? "1" : suffix;
}

function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
            );
        }
        previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
}

function parseItem(text) {
    const reading = text.match(/^(.*?)\s+x(?:\s|$)/i)?.[1];
    if (!reading) return "";
    const normalized = reading.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates = itemDictionary
        .map((item) => {
            const candidate = item.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
            return { item, distance: editDistance(normalized, candidate) / Math.max(normalized.length, candidate.length) };
        })
        .sort((left, right) => left.distance - right.distance);
    return candidates[0]?.distance <= 0.35 ? candidates[0].item : "";
}

function chooseItem(readings) {
    const counts = new Map();
    for (const reading of readings) {
        if (reading === "") continue;
        counts.set(reading, (counts.get(reading) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
    return ranked[0]?.[1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : "";
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
        const events = segment.events.filter((event) => !event.baseline);
        for (const event of events) {
            const frameNumbers = [...new Set([event.stableFrame, event.stableFrame + 1, event.stableFrame + 2])].filter(
                (frame) => frame <= event.lastFrame,
            );
            const readings = [];
            const itemReadings = [];
            const rawReadings = [];
            for (const frameNumber of frameNumbers) {
                const centerY = rowCenter(segment, event, frameNumber, geometry);
                for (const threshold of [130, 150, 170]) {
                    const result = await worker.recognize(quantityImage(frames[frameNumber], centerY, threshold));
                    const text = result.data.text.trim();
                    rawReadings.push(text);
                    readings.push(parseQuantity(text));
                    itemReadings.push(parseItem(text));
                }
            }
            const actual = chooseQuantity(readings);
            const actualItem = chooseItem(itemReadings);
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
        console.log(`Items: ${correctItems}/${events.length} correct, ${wrongItems} wrong, ${events.length - acceptedItems} withheld`);
        console.log(`Quantities: ${correct}/${events.length} correct, ${wrong} wrong, ${events.length - accepted} withheld`);
        console.log(`Complete events: ${correctEvents}/${events.length}`);
        if (mismatches.length > 0) console.log(mismatches.join("\n"));
        if (segment.split !== "development" && (wrong > 0 || wrongItems > 0)) failed = true;
    }
} finally {
    await worker.terminate();
}

if (failed) process.exitCode = 1;
