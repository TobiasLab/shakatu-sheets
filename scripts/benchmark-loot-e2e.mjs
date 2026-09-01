import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker, OEM, PSM } from "tesseract.js";
import {
    benchmarkEvents,
    chooseTemporalPairConsensus,
    compareDetectedEvents,
    parseItem,
    parseQuantity,
    selectOcrObservations,
    trackRowEvents,
    validateGeneratedManifest,
} from "./loot-benchmark-core.mjs";
import { createLootBenchmarkVision } from "./loot-benchmark-vision.mjs";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const developmentOnly = process.argv.includes("--development-only");
const debug = process.argv.includes("--debug");
if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: npm run benchmark:loot:e2e -- <generated-manifest.json> [--development-only] [--debug]");
    process.exit(manifestPath ? 0 : 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateGeneratedManifest(manifest, { requireItemDictionary: true });
const height = manifest.roi.pixels.height;
const itemDictionary = manifest.itemDictionary;
const {
    calibrateGeometry,
    decodeFrames,
    detectRows,
    extractFeatures,
    extractFingerprints,
    extractScoreProfiles,
    fingerprintDistance,
    quantityImage,
} = createLootBenchmarkVision({ manifestPath, manifest });

const selectedSegments = manifest.segments.filter((segment) => !developmentOnly || segment.split === "development");
const prepared = [];
for (const segment of selectedSegments) {
    const frames = await decodeFrames(segment);
    prepared.push({ segment, frames, profiles: extractScoreProfiles(frames) });
}
const development = prepared.filter(({ segment }) => segment.split === "development");
if (development.length === 0) throw new Error("At least one development segment is required.");
const geometry = calibrateGeometry(development, {
    minimumCenter: 12,
    maximumCenter: height - 12,
    errorMessage: "The ROI is too short for the configured maxRows and end-to-end row geometry.",
});
for (const sequence of prepared) {
    sequence.features = extractFeatures(sequence.profiles, geometry.bottomCenter, geometry.spacing);
    sequence.fingerprints = extractFingerprints(sequence.frames, geometry.bottomCenter, geometry.spacing);
    sequence.rows = detectRows(sequence.features, sequence.fingerprints, geometry);
    sequence.tracks = trackRowEvents(sequence.rows, geometry.threshold, fingerprintDistance).filter(
        (track) => !track.baseline,
    );
}

console.log(`Development row geometry: bottom ${geometry.bottomCenter}px, spacing ${geometry.spacing}px`);
console.log(`Development row threshold: ${geometry.threshold} (${geometry.errors} slot errors)`);
console.log("OCR window: first 3 consecutive detected rows after the entrance frame");

const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    langPath: resolve("public/ocr"),
    cacheMethod: "none",
    gzip: true,
});

let failed = false;
try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    for (const sequence of prepared) {
        const predictions = [];
        for (const track of sequence.tracks) {
            const selected = selectOcrObservations(track, geometry.threshold);
            const readingsByFrame = [];
            const rawReadings = [];
            for (const observation of selected) {
                const frameReadings = [];
                for (const threshold of [130, 150, 170]) {
                    const result = await worker.recognize(
                        quantityImage(sequence.frames[observation.frame], observation.centerY, threshold),
                    );
                    const text = result.data.text.trim();
                    rawReadings.push(text);
                    frameReadings.push({
                        item: parseItem(text, itemDictionary),
                        quantity: parseQuantity(text),
                    });
                }
                readingsByFrame.push(frameReadings);
            }
            const recognition = chooseTemporalPairConsensus(readingsByFrame);
            predictions.push({
                id: track.id,
                firstFrame: track.firstFrame,
                selectedFrames: selected.map(({ frame }) => frame),
                ...recognition,
            });
            if (debug) {
                console.log(
                    `${sequence.segment.id}/${track.id} frame ${track.firstFrame}: frames ${selected.map(({ frame }) => frame).join(",") || "none"}; ${recognition.item || "withheld"} x ${recognition.quantity || "withheld"} (${rawReadings.join(" | ")})`,
                );
            }
        }

        const expected = benchmarkEvents(sequence.segment).filter((event) => !event.baseline);
        const comparison = compareDetectedEvents(expected, predictions);
        let correct = 0;
        let accepted = 0;
        const mismatches = [];
        for (const { expected: label, actual } of comparison.matches) {
            const isAccepted = actual.item !== "" && actual.quantity !== "";
            const isCorrect = actual.item === label.item && actual.quantity === String(label.quantity);
            if (isAccepted) accepted += 1;
            if (isCorrect) correct += 1;
            else {
                mismatches.push(
                    `${label.id}: expected ${label.item} x ${label.quantity}, got ${actual.item || "withheld"} x ${actual.quantity || "withheld"} from frames ${actual.selectedFrames.join(",") || "none"}`,
                );
            }
        }
        const inventedAccepted = comparison.invented.filter(
            ({ item, quantity }) => item !== "" && quantity !== "",
        ).length;
        const acceptedTotal = accepted + inventedAccepted;
        console.log(`\n${sequence.segment.id} (${sequence.segment.split})`);
        console.log(
            `Detection: ${comparison.matches.length}/${expected.length} matched, ${comparison.missed.length} missed, ${comparison.invented.length} invented`,
        );
        console.log(
            `Recognition: ${correct}/${expected.length} complete, ${acceptedTotal - correct} wrong, ${expected.length - accepted} withheld or missed`,
        );
        if (mismatches.length > 0) console.log(mismatches.join("\n"));
        if (comparison.missed.length > 0) console.log(`Missed: ${comparison.missed.map(({ id }) => id).join(", ")}`);
        if (comparison.invented.length > 0) {
            console.log(
                `Invented: ${comparison.invented.map(({ id, firstFrame }) => `${id}@${firstFrame}`).join(", ")}`,
            );
        }
        if (
            sequence.segment.split !== "development" &&
            (correct !== expected.length || comparison.missed.length > 0 || comparison.invented.length > 0)
        ) {
            failed = true;
        }
    }
} finally {
    await worker.terminate();
}

if (failed) process.exitCode = 1;
