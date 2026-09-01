import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker, OEM, PSM } from "tesseract.js";
import {
    benchmarkEvents,
    chooseTemporalConsensus,
    chooseTemporalPairConsensus,
    parseItem,
    parseQuantity,
    validateGeneratedManifest,
} from "./loot-benchmark-core.mjs";
import { createLootBenchmarkVision } from "./loot-benchmark-vision.mjs";

const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const developmentOnly = process.argv.includes("--development-only");
const debug = process.argv.includes("--debug");
if (!manifestPath || process.argv.includes("--help")) {
    console.log("Usage: npm run benchmark:loot:ocr -- <generated-manifest.json> [--development-only] [--debug]");
    process.exit(manifestPath ? 0 : 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateGeneratedManifest(manifest, { requireItemDictionary: true });
const height = manifest.roi?.pixels?.height;
const itemDictionary = manifest.itemDictionary;
const { calibrateGeometry, decodeFrames, extractScoreProfiles, quantityImage } = createLootBenchmarkVision({
    manifestPath,
    manifest,
});

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
for (const segment of selectedSegments) {
    const frames = await decodeFrames(segment);
    decoded.push({ segment, frames });
}
const developmentSets = decoded
    .filter(({ segment }) => segment.split === "development")
    .map(({ segment, frames }) => ({ segment, profiles: extractScoreProfiles(frames) }));
if (developmentSets.length === 0) throw new Error("At least one development segment is required.");
const geometry = calibrateGeometry(developmentSets, {
    minimumCenter: 12,
    maximumCenter: height - 12,
    errorMessage: "The ROI is too short for the configured maxRows and OCR row geometry.",
});
console.log(`Development row geometry: bottom ${geometry.bottomCenter}px, spacing ${geometry.spacing}px`);

const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    langPath: resolve("public/ocr"),
    cacheMethod: "none",
    gzip: true,
});

let failed = false;
try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
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
            const pairReadingsByFrame = [];
            const rawReadings = [];
            for (const frameNumber of frameNumbers) {
                const centerY = rowCenter(segment, event, frameNumber, geometry);
                const frameReadings = [];
                const frameItemReadings = [];
                const framePairReadings = [];
                for (const threshold of [130, 150, 170]) {
                    const result = await worker.recognize(quantityImage(frames[frameNumber], centerY, threshold));
                    const text = result.data.text.trim();
                    rawReadings.push(text);
                    const reading = {
                        item: parseItem(text, itemDictionary),
                        quantity: parseQuantity(text),
                    };
                    frameReadings.push(reading.quantity);
                    frameItemReadings.push(reading.item);
                    framePairReadings.push(reading);
                }
                readingsByFrame.push(frameReadings);
                itemReadingsByFrame.push(frameItemReadings);
                pairReadingsByFrame.push(framePairReadings);
            }
            const actual = chooseTemporalConsensus(readingsByFrame);
            const actualItem = chooseTemporalConsensus(itemReadingsByFrame);
            const actualPair = chooseTemporalPairConsensus(pairReadingsByFrame);
            if (actual !== "") accepted += 1;
            if (actualItem !== "") acceptedItems += 1;
            if (actual === String(event.quantity)) correct += 1;
            else mismatches.push(`${event.id}: expected ${event.quantity}, got ${actual || "withheld"}`);
            if (actualItem === event.item) correctItems += 1;
            else mismatches.push(`${event.id}: expected ${event.item}, got ${actualItem || "withheld"}`);
            if (actualPair.quantity === String(event.quantity) && actualPair.item === event.item) correctEvents += 1;
            else if (actual === String(event.quantity) && actualItem === event.item) {
                const pair =
                    actualPair.item === "" || actualPair.quantity === ""
                        ? "withheld"
                        : `${actualPair.item} x ${actualPair.quantity}`;
                mismatches.push(`${event.id}: expected complete ${event.item} x ${event.quantity}, got ${pair}`);
            }
            if (debug) {
                console.log(
                    `${segment.id}/${event.id}: ${actualPair.item || "withheld"} x ${actualPair.quantity || "withheld"} (${rawReadings.join(" | ")})`,
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
