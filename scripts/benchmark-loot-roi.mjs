import { createHash } from "node:crypto";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LiveLootCoordinator, NORMAL_LOOT_OCR_SELECTION } from "../src/recognition/liveLoot.ts";
import { preprocessLootOcrFrame, readLootOcrFrame } from "../src/recognition/liveLootOcr.ts";
import { findLiveLootProfile, findRareLootGeometry } from "../src/recognition/liveLootProfiles.ts";
import { isLootFont } from "../src/recognition/lootFont.ts";
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
    options: {
        validation: { type: "boolean" },
        ocr: { type: "boolean" },
        output: { type: "string" },
        annotations: { type: "string" },
        trace: { type: "string" },
        "sample-step": { type: "string", default: "1" },
        "sample-offset": { type: "string", default: "0" },
    },
});
const split = values.validation ? "validation" : "development";
const useOcr = values.ocr ?? false;
const output = values.output;
const sampleStep = Number(values["sample-step"]);
const sampleOffset = Number(values["sample-offset"]);
if (![1, 2].includes(sampleStep) || !Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset >= sampleStep)
    throw new Error("Sampling requires --sample-step 1 or 2 and an offset smaller than the step.");
if (!root)
    throw new Error(
        "Usage: npm run benchmark:loot:roi -- <live-loot directory> [--validation] [--ocr] [--annotations labels.json] [--output report.json] [--trace readings.jsonl] [--sample-step 1|2] [--sample-offset 0|1]",
    );
for (const path of [values.output, values.trace].filter(Boolean)) {
    const fromRoot = relative(resolve(root), resolve(path));
    if (!isAbsolute(fromRoot) && fromRoot.split(sep)[0] !== "..")
        throw new Error("Write analysis outside the source corpus.");
}
if (values.output && values.trace && resolve(values.output) === resolve(values.trace))
    throw new Error("Report and trace paths must differ.");
if (values.trace) await writeFile(values.trace, "", { flag: "wx" });
const annotations = JSON.parse(await readFile(values.annotations ?? join(root, "annotations.json"), "utf8"));
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
        const font = run.font ?? manifest.font ?? "korean";
        if (!isLootFont(font)) throw new Error(`${run.id}: invalid font.`);
        const artifact = findLiveLootProfile(
            manifest.sourceDimensions?.width,
            manifest.sourceDimensions?.height,
            manifest.uiScalePercent,
            [362, 453].includes(manifest.normalCrop?.pixels?.width),
        );
        const rareGeometry = findRareLootGeometry(
            manifest.sourceDimensions?.width,
            manifest.sourceDimensions?.height,
            manifest.uiScalePercent,
            [400, 500].includes(manifest.rareCrop?.pixels?.width),
        );
        if (
            rareGeometry === null ||
            artifact === null ||
            manifest.version !== 1 ||
            manifest.sourceDimensions?.width !== artifact.capture.sourceWidth ||
            manifest.sourceDimensions?.height !== artifact.capture.sourceHeight ||
            manifest.uiScalePercent !== artifact.capture.uiScalePercent ||
            ![8, 16].includes(manifest.targetFps)
        )
            throw new Error(`${run.id}: unsupported capture profile.`);
        const normalIds = await batchIds(join(directory, "normal"));
        const rareIds = await batchIds(join(directory, "rare"));
        if (normalIds.length !== rareIds.length || normalIds.some((id, index) => id !== rareIds[index]))
            throw new Error(`${run.id}: normal/rare batches do not match.`);
        const replayIds = normalIds.filter((_, index) => index % sampleStep === sampleOffset);
        if (!replayIds.length) throw new Error(`${run.id}: no frames at the selected sampling offset.`);
        const sampleFps = manifest.targetFps === 16 && sampleStep === 1 ? 16 : 8;
        for (const kind of ["normal", "rare"]) {
            const profile = kind === "normal" ? artifact.profile : rareLootDetectionProfile(rareGeometry);
            const crop = manifest[`${kind}Crop`]?.pixels;
            if (crop?.width !== profile.width || crop?.height !== profile.height)
                throw new Error(`${run.id}: unsupported ${kind} geometry.`);
            const analyzer = new RareLootFrameAnalyzer(rareGeometry, sampleFps);
            const results = [];
            let ocrJobs = 0;
            let ocrCalls = 0;
            let lastOcrEventId;
            const coordinator = new LiveLootCoordinator({
                font,
                sampleFps,
                ocrSelection: NORMAL_LOOT_OCR_SELECTION,
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
                    ocrCalls += 1;
                    if (frames[0]?.eventId !== lastOcrEventId) ocrJobs += 1;
                    lastOcrEventId = frames[0]?.eventId;
                    const readings = [];
                    for (const frame of frames) {
                        if (values.trace) frame.diagnostics = { passes: [] };
                        if (!worker) {
                            readings.push([]);
                            continue;
                        }
                        const texts = await readLootOcrFrame(
                            frame.textColor,
                            async (threshold, scale, region) => {
                                await worker.setParameters({
                                    tessedit_pageseg_mode: region === "quantity" ? "8" : "7",
                                    tessedit_char_whitelist: region === "quantity" ? "0123456789" : "",
                                });
                                const image = preprocessLootOcrFrame(
                                    frame.roi,
                                    frame.observation.centerY,
                                    threshold,
                                    region === "quantity" ? frame.observation.fingerprint.digits?.bounds : frame.bounds,
                                    frame.textColor,
                                    scale,
                                );
                                const grayscale = Buffer.alloc(image.width * image.height);
                                for (let i = 0; i < grayscale.length; i += 1) grayscale[i] = image.pixels[i * 4];
                                const pgm = Buffer.concat([
                                    Buffer.from(`P5\n${image.width} ${image.height}\n255\n`),
                                    grayscale,
                                ]);
                                const text = (await worker.recognize(pgm)).data.text.trim();
                                frame.diagnostics?.passes.push({ threshold, scale, region, text });
                                return text;
                            },
                            frame.textColor !== "gold" && !!frame.observation.fingerprint.digits,
                            font,
                        );
                        readings.push(texts);
                    }
                    if (values.trace)
                        await appendFile(
                            values.trace,
                            `${JSON.stringify({
                                run: run.id,
                                kind,
                                eventId: frames[0]?.eventId,
                                frames: frames.map((frame, index) => ({
                                    batchId: replayIds[frame.frame],
                                    centerY: frame.observation.centerY,
                                    bounds: frame.bounds,
                                    readings: readings[index],
                                    passes: frame.diagnostics?.passes,
                                })),
                            })}\n`,
                        );
                    return readings;
                },
                onResult: (result) =>
                    results.push({
                        ...result,
                        firstBatchId: replayIds[result.firstFrame],
                        selectedBatchIds: result.selectedFrames.map((frame) => replayIds[frame]),
                    }),
            });
            try {
                let sourceIndex = 0;
                for await (const frame of decodeRoiFrames(
                    join(directory, kind),
                    profile.width,
                    profile.height,
                    normalIds.length,
                )) {
                    if (sourceIndex++ % sampleStep !== sampleOffset) continue;
                    coordinator.pushFrame(frame);
                    while (coordinator.pendingOcrJobCount > 0) await delay(1);
                }
                await coordinator.finish();
            } finally {
                coordinator.stop();
            }
            const expectedDigest = useOcr && sampleStep === 1 ? run.expectedResultsSha256?.[kind] : undefined;
            const matchesBaseline =
                expectedDigest === undefined
                    ? undefined
                    : createHash("sha256").update(JSON.stringify(results)).digest("hex") === expectedDigest;
            if (matchesBaseline === false) failed = true;
            const summary = {
                ...(matchesBaseline === undefined ? {} : { matchesBaseline }),
                run: run.id,
                font,
                kind,
                frames: replayIds.length,
                sourceFrames: normalIds.length,
                sampleStep,
                sampleOffset,
                candidates: results.length,
                ocrJobs,
                ocrCalls,
                insufficient: results.filter((result) => result.reason === "insufficient-observations").length,
                ...(useOcr ? { recognized: results.filter((result) => result.status === "recognized").length } : {}),
                reviewed: run[`${kind}Reviewed`] === true,
            };
            if (summary.reviewed) summary.comparison = compare(run[`${kind}Events`], results, useOcr);
            const reviewedCases =
                kind === "normal"
                    ? [...cases.filter((test) => test.run === run.id), ...(run.normalCases ?? [])].map((test) => ({
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
