import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { benchmarkEvents, compareEvents, trackRowEvents, validateGeneratedManifest } from "./loot-benchmark-core.mjs";
import { createLootBenchmarkVision } from "./loot-benchmark-vision.mjs";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const debug = process.argv.includes("--debug");
const developmentOnly = process.argv.includes("--development-only");
if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: npm run benchmark:loot:track -- <generated-manifest.json> [--development-only] [--debug]");
    process.exit(manifestPath ? 0 : 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateGeneratedManifest(manifest);
const {
    calibrateGeometry,
    decodeFrames,
    detectRows,
    extractFeatures,
    extractFingerprints,
    extractScoreProfiles,
    fingerprintDistance,
} = createLootBenchmarkVision({ manifestPath, manifest });

function activeCount(events, frame) {
    return events.filter((event) => event.firstFrame <= frame && event.lastFrame >= frame).length;
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
    const rows = detectRows(features, fingerprints, geometry);
    const actual = trackRowEvents(rows, geometry.threshold, fingerprintDistance)
        .filter((event) => !event.baseline)
        .map((event) => event.firstFrame);
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
