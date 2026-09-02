import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLootRoiFrame, lootFingerprintDistance } from "../src/recognition/liveLoot.ts";
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
import {
    assertDistinctLootProfileOutput,
    assertLootProfileExportEligible,
    createLootProfileArtifact,
    LOOT_E2E_USAGE,
    parseLootE2eArguments,
    writeLootProfileArtifactAtomic,
} from "./loot-profile-artifact.mjs";

export async function runLootE2eBenchmark({ manifestPath, profileOutput, developmentOnly, debug }) {
    await assertDistinctLootProfileOutput(manifestPath, profileOutput);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    validateGeneratedManifest(manifest, { requireItemDictionary: true });
    const height = manifest.roi.pixels.height;
    const width = manifest.roi.pixels.width;
    const itemDictionary = manifest.itemDictionary;
    const { calibrateGeometry, decodeFrames, extractScoreProfiles, quantityImage } = createLootBenchmarkVision({
        manifestPath,
        manifest,
    });

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
    const profile = {
        width,
        height,
        maxRows: manifest.maxRows,
        bottomCenter: geometry.bottomCenter,
        spacing: geometry.spacing,
        rowThreshold: geometry.threshold,
    };
    for (const sequence of prepared) {
        sequence.rows = sequence.frames.map((pixels) => analyzeLootRoiFrame({ width, height, pixels }, profile));
        sequence.tracks = trackRowEvents(sequence.rows, geometry.threshold, lootFingerprintDistance).filter(
            (track) => !track.baseline,
        );
    }

    console.log(`Development row geometry: bottom ${geometry.bottomCenter}px, spacing ${geometry.spacing}px`);
    console.log(`Development row threshold: ${geometry.threshold} (${geometry.errors} slot errors)`);
    console.log("OCR window: first 3 consecutive detected rows after the entrance frame");

    const { createWorker, OEM, PSM } = await import("tesseract.js");
    const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        langPath: fileURLToPath(new URL("../public/ocr", import.meta.url)),
        cacheMethod: "none",
        gzip: true,
    });

    let failed = false;
    const results = [];
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
            if (comparison.missed.length > 0)
                console.log(`Missed: ${comparison.missed.map(({ id }) => id).join(", ")}`);
            if (comparison.invented.length > 0) {
                console.log(
                    `Invented: ${comparison.invented.map(({ id, firstFrame }) => `${id}@${firstFrame}`).join(", ")}`,
                );
            }
            const result = {
                id: sequence.segment.id,
                split: sequence.segment.split,
                expectedCount: expected.length,
                matchedCount: comparison.matches.length,
                correctCount: correct,
                missedCount: comparison.missed.length,
                inventedCount: comparison.invented.length,
            };
            results.push(result);
            if (
                result.split !== "development" &&
                (result.correctCount !== result.expectedCount || result.missedCount > 0 || result.inventedCount > 0)
            ) {
                failed = true;
            }
        }
    } finally {
        await worker.terminate();
    }

    if (profileOutput !== undefined) {
        assertLootProfileExportEligible(results);
        const artifact = createLootProfileArtifact(manifest, profile);
        await writeLootProfileArtifactAtomic(profileOutput, artifact, { protectedInputPath: manifestPath });
        console.log(`Wrote live-loot profile artifact to ${profileOutput}`);
    }
    return failed ? 1 : 0;
}

export async function main(arguments_ = process.argv.slice(2)) {
    const options = parseLootE2eArguments(arguments_);
    if (options.help) {
        console.log(LOOT_E2E_USAGE);
        console.log(
            "  --profile-output <path>  Export V1 profile after exact validation/test detection and recognition.",
        );
        return 0;
    }
    return runLootE2eBenchmark(options);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) process.exitCode = await main();
