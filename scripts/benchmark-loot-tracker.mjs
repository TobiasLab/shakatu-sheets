import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
    benchmarkEvents,
    calibrateThreshold,
    compareEvents,
    stackShifted,
    validateGeneratedManifest,
} from "./loot-benchmark-core.mjs";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const debug = process.argv.includes("--debug");
const developmentOnly = process.argv.includes("--development-only");
if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: npm run benchmark:loot:track -- <generated-manifest.json> [--development-only] [--debug]");
    process.exit(manifestPath ? 0 : 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateGeneratedManifest(manifest);
const benchmarkDirectory = dirname(manifestPath);
const width = manifest.roi?.pixels?.width;
const height = manifest.roi?.pixels?.height;
const maxRows = manifest.maxRows;

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

function isGlyphPixel(frame, offset) {
    const light = luminance(frame, offset);
    const chroma =
        Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
        Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
    const horizontal = Math.min(luminance(frame, offset - 6), luminance(frame, offset + 6));
    const vertical = Math.min(luminance(frame, offset - width * 6), luminance(frame, offset + width * 6));
    return light >= 115 && chroma <= 55 && light - Math.min(horizontal, vertical) >= 18;
}

function rowScore(frame, centerY) {
    let score = 0;
    const left = Math.round(width * 0.22);
    const right = Math.round(width * 0.96);
    for (let y = centerY - 6; y <= centerY + 6; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * width + x) * 3;
            if (isGlyphPixel(frame, offset)) score += 1;
        }
    }
    return score;
}

function rowFingerprint(frame, centerY) {
    const left = Math.round(width * 0.27);
    const right = Math.round(width * 0.96);
    const quantityLeft = Math.round(width * 0.58);

    function project(startX) {
        const projection = new Uint8Array(right - startX);
        for (let x = startX; x < right; x += 1) {
            let brightPixels = 0;
            for (let y = centerY - 9; y <= centerY + 9; y += 1) {
                const offset = (y * width + x) * 3;
                const chroma =
                    Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
                    Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
                if (luminance(frame, offset) >= 150 && chroma <= 40) brightPixels += 1;
            }
            projection[x - startX] = brightPixels;
        }
        return projection;
    }

    return { full: project(left), quantity: project(quantityLeft) };
}

function fingerprintDistance(left, right) {
    if (!left || !right) return 0;

    function cosineDistance(leftProjection, rightProjection) {
        let dot = 0;
        let leftLength = 0;
        let rightLength = 0;
        for (let index = 0; index < leftProjection.length; index += 1) {
            dot += leftProjection[index] * rightProjection[index];
            leftLength += leftProjection[index] ** 2;
            rightLength += rightProjection[index] ** 2;
        }
        if (leftLength === 0 || rightLength === 0) return leftLength === rightLength ? 0 : 1;
        return 1 - dot / Math.sqrt(leftLength * rightLength);
    }

    return Math.max(cosineDistance(left.full, right.full), cosineDistance(left.quantity, right.quantity));
}

function extractScoreProfiles(frames) {
    return frames.map((frame) =>
        Array.from({ length: height }, (_, centerY) =>
            centerY >= 8 && centerY < height - 8 ? rowScore(frame, centerY) : 0,
        ),
    );
}

function extractFeatures(profiles, bottomCenter, spacing) {
    return profiles.map((profile) =>
        Array.from({ length: maxRows }, (_, index) => profile[bottomCenter - (maxRows - index - 1) * spacing]),
    );
}

function extractFingerprints(frames, bottomCenter, spacing) {
    return frames.map((frame) =>
        Array.from({ length: maxRows }, (_, index) =>
            rowFingerprint(frame, bottomCenter - (maxRows - index - 1) * spacing),
        ),
    );
}

function activeCount(events, frame) {
    return events.filter((event) => event.firstFrame <= frame && event.lastFrame >= frame).length;
}

function calibrateRowThreshold(trainingSets) {
    const examples = [];
    for (const { segment, features } of trainingSets) {
        for (let frame = 0; frame < features.length; frame += 1) {
            const count = activeCount(benchmarkEvents(segment), frame);
            for (let slot = 0; slot < maxRows; slot += 1) {
                examples.push({ score: features[frame][slot], occupied: slot >= maxRows - count });
            }
        }
    }
    return calibrateThreshold(examples);
}

function calibrateGeometry(trainingSets) {
    let best;
    for (let bottomCenter = Math.round(height * 0.58); bottomCenter <= Math.round(height * 0.88); bottomCenter += 1) {
        for (let spacing = Math.round(height * 0.11); spacing <= Math.round(height * 0.18); spacing += 1) {
            if (bottomCenter + 9 >= height || bottomCenter - (maxRows - 1) * spacing < 9) continue;
            const sets = trainingSets.map(({ segment, profiles }) => ({
                segment,
                features: extractFeatures(profiles, bottomCenter, spacing),
            }));
            const calibration = calibrateRowThreshold(sets);
            if (!best || calibration.errors < best.errors) {
                best = { bottomCenter, spacing, ...calibration };
            }
        }
    }
    if (!best) throw new Error("The ROI is too short for the configured maxRows and row geometry.");
    return best;
}

function detectRows(features, fingerprints, threshold) {
    return features.map((scores, frame) => {
        const detected = scores.map((score) => score >= threshold);
        let count = 0;
        for (let slot = maxRows - 1; slot >= 0 && detected[slot]; slot -= 1) count += 1;
        const occupied = detected.map((_, slot) => slot >= maxRows - count);
        return {
            count: occupied.filter(Boolean).length,
            strength: scores.reduce((total, score, index) => total + (occupied[index] ? score : 0), 0),
            fingerprint: count === 0 ? undefined : fingerprints[frame][maxRows - 1],
            fingerprints: count === 0 ? [] : fingerprints[frame].slice(maxRows - count),
        };
    });
}

function trackEvents(rows, rowThreshold) {
    const events = [];
    for (let frame = 1; frame < rows.length; frame += 1) {
        const previous = rows[frame - 1];
        const current = rows[frame];
        const next = rows[frame + 1];
        if (previous.count === 0 && current.count > 0 && next?.count === 0) {
            continue;
        }
        const additions = Math.max(0, current.count - previous.count);
        for (let index = 0; index < additions; index += 1) events.push(frame);
        const strengthChange = current.strength - previous.strength;
        const replacementEvidence =
            fingerprintDistance(current.fingerprint, previous.fingerprint) >= 0.1 ||
            stackShifted(previous.fingerprints, current.fingerprints, fingerprintDistance) ||
            strengthChange >= rowThreshold * 2;
        if (
            additions === 0 &&
            current.count > 0 &&
            current.count === previous.count &&
            replacementEvidence &&
            current.strength / current.count >= rowThreshold * 2 &&
            strengthChange >= -rowThreshold / 2
        ) {
            events.push(frame);
        }
    }
    return events;
}

function expectedFrames(segment) {
    return benchmarkEvents(segment)
        .filter((event) => !event.baseline)
        .map((event) => event.firstFrame);
}

const prepared = [];
const selectedSegments = manifest.segments.filter((segment) => !developmentOnly || segment.split === "development");
for (const segment of selectedSegments) {
    const frames = await decodeFrames(segment);
    prepared.push({ segment, frames, profiles: extractScoreProfiles(frames) });
}

const development = prepared.filter(({ segment }) => segment.split === "development");
if (development.length === 0) throw new Error("The tracker benchmark requires at least one development segment.");
const geometry = calibrateGeometry(development);
for (const preparedSegment of prepared) {
    preparedSegment.features = extractFeatures(preparedSegment.profiles, geometry.bottomCenter, geometry.spacing);
    preparedSegment.fingerprints = extractFingerprints(preparedSegment.frames, geometry.bottomCenter, geometry.spacing);
}
console.log(`Development row geometry: bottom ${geometry.bottomCenter}px, spacing ${geometry.spacing}px`);
console.log(`Development row threshold: ${geometry.threshold} (${geometry.errors} slot errors)`);
console.log(
    "Replacement gate: bottom/stack signature 0.1, brightness reset 2x threshold, average strength 2x, maximum fade drop 0.5x",
);
let failed = false;
for (const { segment, features, fingerprints } of prepared) {
    const rows = detectRows(features, fingerprints, geometry.threshold);
    const actual = trackEvents(rows, geometry.threshold);
    const expected = expectedFrames(segment);
    const comparison = compareEvents(expected, actual);
    const countErrors = rows.filter((row, frame) => row.count !== activeCount(benchmarkEvents(segment), frame)).length;
    console.log(`\n${segment.id} (${segment.split})`);
    console.log(`Rows: ${rows.length - countErrors}/${rows.length} frames correct`);
    console.log(`Events: ${comparison.matches.length}/${expected.length} matched`);
    console.log(`Expected: ${expected.join(", ")}`);
    console.log(`Actual:   ${actual.join(", ")}`);
    if (comparison.missed.length > 0) console.log(`Missed: ${comparison.missed.join(", ")}`);
    if (comparison.invented.length > 0) console.log(`Invented: ${comparison.invented.join(", ")}`);
    if (debug) {
        const expectedBirths = new Set(expected);
        for (let frame = 1; frame < rows.length; frame += 1) {
            if (rows[frame].count === 0 || rows[frame].count !== rows[frame - 1].count) continue;
            const signatureChange = fingerprintDistance(rows[frame].fingerprint, rows[frame - 1].fingerprint) * 1_000;
            const strengthChange = rows[frame].strength - rows[frame - 1].strength;
            if (expectedBirths.has(frame) || signatureChange >= 100 || strengthChange >= 200) {
                console.log(
                    `refresh ${frame}${expectedBirths.has(frame) ? " expected" : ""}: signature ${signatureChange.toFixed(1)}, strength ${strengthChange}`,
                );
            }
        }
        for (let frame = 0; frame < rows.length; frame += 1) {
            const expectedCount = activeCount(benchmarkEvents(segment), frame);
            if (rows[frame].count !== expectedCount) {
                console.log(
                    `frame ${frame}: expected ${expectedCount}, got ${rows[frame].count}; scores ${features[frame].join(",")}`,
                );
            }
        }
    }
    if (segment.split !== "development" && (comparison.missed.length > 0 || comparison.invented.length > 0))
        failed = true;
}
if (failed) process.exitCode = 1;
