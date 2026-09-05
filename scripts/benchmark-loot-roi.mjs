import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LiveLootCoordinator } from "../src/recognition/liveLoot.ts";
import { preprocessLootOcrFrame } from "../src/recognition/liveLootOcr.ts";
import { findLiveLootProfile, findRareLootGeometry } from "../src/recognition/liveLootProfiles.ts";
import {
    RARE_LOOT_OCR_SELECTION,
    RareLootFrameAnalyzer,
    rareLootDetectionProfile,
} from "../src/recognition/rareLoot.ts";
import { decodeRoiFrames } from "./loot-roi-decoder.mjs";

const args = process.argv.slice(2);
const root = args.shift();
const { values } = parseArgs({
    args,
    options: { validation: { type: "boolean" }, ocr: { type: "boolean" }, output: { type: "string" } },
});
const split = values.validation ? "validation" : "development";
const useOcr = values.ocr ?? false;
const output = values.output;
if (!root)
    throw new Error(
        "Usage: npm run benchmark:loot:roi -- <live-loot directory> [--validation] [--ocr] [--output report.json]",
    );
const annotations = JSON.parse(await readFile(join(root, "annotations.json"), "utf8"));
const cases = JSON.parse(await readFile(new URL("./fixtures/loot-roi-cases.json", import.meta.url), "utf8"));
if (annotations.version !== 1 || !Array.isArray(annotations.runs) || !annotations.itemDictionary?.length)
    throw new Error("Unsupported ROI annotations.");

async function batchIds(directory) {
    const paths = [];
    for (const minute of (await readdir(directory)).filter((name) => /^minute-\d+$/.test(name)).sort()) {
        for (const name of (await readdir(join(directory, minute)))
            .filter((name) => /^frame-\d+\.png$/.test(name))
            .sort())
            paths.push(join(minute, name));
    }
    const ids = paths.map((path) => Number(/frame-(\d+)\.png$/.exec(path)[1]));
    if (!ids.length || ids.some((id, index) => !Number.isSafeInteger(id) || (index > 0 && id !== ids[index - 1] + 1)))
        throw new Error(`${directory}: missing or unordered batches; cannot replay as consecutive observations.`);
    return ids;
}

function compare(expected, results, ocr) {
    const remaining = [...results];
    let matched = 0;
    let correct = 0;
    for (const event of expected) {
        const index = remaining.findIndex(
            (result) =>
                result.firstBatchId >= event.firstBatchId &&
                result.firstBatchId <= (event.lastBatchId ?? event.firstBatchId + 1),
        );
        if (index < 0) continue;
        matched += 1;
        const [result] = remaining.splice(index, 1);
        if (result.status === "recognized" && result.itemName === event.item && result.quantity === event.quantity)
            correct += 1;
    }
    return {
        expected: expected.length,
        matched,
        missed: expected.length - matched,
        extra: remaining.length,
        ...(ocr ? { correct } : {}),
    };
}

let worker;
const report = {
    split,
    ocr: useOcr,
    note: "Accuracy replay waits for OCR; it does not measure real-time throughput. Unreviewed runs have diagnostic counts only.",
    runs: [],
};
let failed = false;
try {
    if (useOcr) {
        const { createWorker, OEM, PSM } = await import("tesseract.js");
        worker = await createWorker("eng", OEM.LSTM_ONLY, {
            langPath: fileURLToPath(new URL("../public/ocr", import.meta.url)),
            cacheMethod: "none",
            gzip: true,
        });
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    }
    for (const run of annotations.runs.filter((run) => run.split === split)) {
        if (!/^run-\d+-\d+-\d+$/.test(run.id)) throw new Error("Invalid run directory.");
        const directory = join(root, run.id);
        const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
        const artifact = findLiveLootProfile(
            manifest.sourceDimensions?.width,
            manifest.sourceDimensions?.height,
            manifest.uiScalePercent,
        );
        const rareGeometry = findRareLootGeometry(
            manifest.sourceDimensions?.width,
            manifest.sourceDimensions?.height,
            manifest.uiScalePercent,
        );
        if (
            rareGeometry === null ||
            artifact === null ||
            manifest.version !== 1 ||
            manifest.sourceDimensions?.width !== artifact.capture.sourceWidth ||
            manifest.sourceDimensions?.height !== artifact.capture.sourceHeight ||
            manifest.uiScalePercent !== artifact.capture.uiScalePercent ||
            manifest.targetFps !== artifact.capture.sampleFps
        )
            throw new Error(`${run.id}: unsupported capture profile.`);
        const normalIds = await batchIds(join(directory, "normal"));
        const rareIds = await batchIds(join(directory, "rare"));
        if (normalIds.length !== rareIds.length || normalIds.some((id, index) => id !== rareIds[index]))
            throw new Error(`${run.id}: normal/rare batches do not match.`);
        for (const kind of ["normal", "rare"]) {
            const profile = kind === "normal" ? artifact.profile : rareLootDetectionProfile(rareGeometry);
            const crop = manifest[`${kind}Crop`]?.pixels;
            if (crop?.width !== profile.width || crop?.height !== profile.height)
                throw new Error(`${run.id}: unsupported ${kind} geometry.`);
            const analyzer = new RareLootFrameAnalyzer(rareGeometry);
            const results = [];
            let ocrJobs = 0;
            const coordinator = new LiveLootCoordinator({
                profile,
                dictionary: annotations.itemDictionary,
                ...(kind === "rare"
                    ? {
                          analyzeFrame: (frame) => analyzer.pushFrame(frame),
                          ocrSelection: RARE_LOOT_OCR_SELECTION,
                          ocrBounds: rareGeometry.ocrBounds,
                          ocrTextColor: "gold",
                      }
                    : {}),
                maxPendingOcrJobs: 8,
                readText: async (frames) => {
                    ocrJobs += 1;
                    if (!worker) return frames.map(() => []);
                    const readings = [];
                    for (const frame of frames) {
                        const texts = [];
                        for (const threshold of [130, 150, 170]) {
                            const image = preprocessLootOcrFrame(
                                frame.roi,
                                frame.observation.centerY,
                                threshold,
                                frame.bounds,
                                frame.textColor,
                            );
                            const grayscale = Buffer.alloc(image.width * image.height);
                            for (let i = 0; i < grayscale.length; i += 1) grayscale[i] = image.pixels[i * 4];
                            const pgm = Buffer.concat([
                                Buffer.from(`P5\n${image.width} ${image.height}\n255\n`),
                                grayscale,
                            ]);
                            texts.push((await worker.recognize(pgm)).data.text.trim());
                        }
                        readings.push(texts);
                    }
                    return readings;
                },
                onResult: (result) =>
                    results.push({
                        ...result,
                        firstBatchId: normalIds[result.firstFrame],
                        selectedBatchIds: result.selectedFrames.map((frame) => normalIds[frame]),
                    }),
            });
            try {
                for await (const frame of decodeRoiFrames(
                    join(directory, kind),
                    profile.width,
                    profile.height,
                    normalIds.length,
                )) {
                    coordinator.pushFrame(frame);
                    while (coordinator.pendingOcrJobCount > 0) await delay(1);
                }
                await coordinator.finish();
            } finally {
                coordinator.stop();
            }
            const summary = {
                run: run.id,
                kind,
                frames: normalIds.length,
                candidates: results.length,
                ocrJobs,
                insufficient: results.filter((result) => result.reason === "insufficient-observations").length,
                ...(useOcr ? { recognized: results.filter((result) => result.status === "recognized").length } : {}),
                reviewed: run[`${kind}Reviewed`] === true,
            };
            if (summary.reviewed) summary.comparison = compare(run[`${kind}Events`], results, useOcr);
            const reviewedCases =
                kind === "normal"
                    ? cases
                          .filter((test) => test.run === run.id)
                          .map((test) => ({
                              id: test.id,
                              ...compare(
                                  test.events,
                                  results.filter(
                                      (result) =>
                                          result.firstBatchId >= test.firstBatchId &&
                                          result.firstBatchId <= test.lastBatchId,
                                  ),
                                  useOcr,
                              ),
                          }))
                    : [];
            for (const comparison of [...reviewedCases, ...(summary.comparison ? [summary.comparison] : [])]) {
                if (comparison.missed || comparison.extra || (useOcr && comparison.correct !== comparison.expected))
                    failed = true;
            }
            console.log(JSON.stringify({ ...summary, reviewedCases }));
            report.runs.push({ ...summary, reviewedCases, results });
        }
    }
    if (!report.runs.length) throw new Error(`No ${split} runs.`);
    if (output) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
} finally {
    await worker?.terminate();
}
process.exitCode = failed ? 1 : 0;
