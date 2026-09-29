import {
    learnableImages,
    prepareQuantityLearning,
    quantityImage,
    suggestUnresolvedQuantity,
} from "../src/recognition/quantityLearning.ts";

const MAX_EXAMPLES = 200;
const MAX_PROFILE_EXAMPLES = 50;

function sameImage(a, b) {
    if (!a || !b) return a === b;
    if (a.width !== b.width || a.height !== b.height || a.pixels.length !== b.pixels.length) return false;
    for (let index = 0; index < a.pixels.length; index++) if (a.pixels[index] !== b.pixels[index]) return false;
    return true;
}

/** Keeps only the text band an OCR frame's learning crops need, so a long replay does not retain full ROIs. */
export function learningFrame(frame, readings) {
    const digits = frame.observation.fingerprint.digits;
    const bands = [digits?.bounds, digits?.itemBounds].filter(Boolean);
    const top = bands.length ? Math.min(...bands.map((bounds) => bounds.top)) : 0;
    const bottom = bands.length ? Math.max(...bands.map((bounds) => bounds.bottom)) : 0;
    const { width } = frame.roi;
    const shift = (bounds) => bounds && { ...bounds, top: bounds.top - top, bottom: bounds.bottom - top };
    return {
        frame: {
            frame: frame.frame,
            roi: { width, height: bottom - top, pixels: frame.roi.pixels.slice(top * width * 4, bottom * width * 4) },
            observation: {
                fingerprint: {
                    digits: digits && { bounds: shift(digits.bounds), itemBounds: shift(digits.itemBounds) },
                },
            },
            diagnostics: frame.diagnostics && { passes: [...frame.diagnostics.passes] },
        },
        readings,
    };
}

/**
 * Replays learning over one run's events in order. Before an event teaches the library, the event is matched the way
 * Needs attention prefills a draft (one crop) and the way automatic recovery decides (every frame and OCR reading).
 * Saves follow the Rust storage rules: identical-pair deduplication, conflicting-label rejection, and newest-first
 * pruning per setup and overall.
 */
export function createLearningReplay(profile, dictionary) {
    const examples = [];
    let model = prepareQuantityLearning({ enabled: true, autoAllow: true, examples });
    const report = {
        events: 0,
        taught: 0,
        duplicates: 0,
        conflicts: 0,
        unlearnable: 0,
        firstEligibleEvent: null,
        prefill: {
            quantity: { correct: 0, wrong: 0, none: 0 },
            item: { correct: 0, wrong: 0, none: 0 },
        },
        automatic: { correct: 0, wrong: 0, wrongEvents: [] },
        unresolved: [],
    };

    function teach(capture, label) {
        const images = learnableImages(capture);
        if (!images) {
            report.unlearnable += 1;
            return;
        }
        const example = {
            id: `replay-${report.events}`,
            profile,
            quantity: label.quantity,
            itemName: label.itemName,
            itemImage: images.item ?? null,
            width: images.quantity.width,
            height: images.quantity.height,
            pixels: images.quantity.pixels,
            originalQuantity: null,
            originalText: "",
            confirmedAt: report.events,
        };
        // Rust rejects a conflicting label before it treats an identical pair as a retry.
        if (
            examples.some(
                (saved) =>
                    (sameImage(saved, example) && saved.quantity !== example.quantity) ||
                    (example.itemImage &&
                        sameImage(saved.itemImage, example.itemImage) &&
                        saved.itemName !== example.itemName),
            )
        ) {
            report.conflicts += 1;
            return;
        }
        if (
            examples.some(
                (saved) =>
                    sameImage(saved, example) &&
                    sameImage(saved.itemImage, example.itemImage) &&
                    saved.itemName === example.itemName,
            )
        ) {
            report.duplicates += 1;
            return;
        }
        examples.unshift(example);
        // One profile per run, so the per-setup cap is the effective limit.
        examples.splice(Math.min(MAX_PROFILE_EXAMPLES, MAX_EXAMPLES));
        report.taught += 1;
        model = prepareQuantityLearning({ enabled: true, autoAllow: true, examples });
        if (report.firstEligibleEvent === null && model.eligibleCount > 0) report.firstEligibleEvent = report.events;
    }

    function score(counts, predicted, actual) {
        if (predicted === undefined) counts.none += 1;
        else if (predicted === actual) counts.correct += 1;
        else counts.wrong += 1;
    }

    return {
        /** `observed` holds the event's frames from `learningFrame`, in OCR order. */
        event(result, observed, firstBatchId) {
            report.events += 1;
            const frames = observed.map((entry) => entry.frame);
            const readings = observed.map((entry) => entry.readings);
            const first = frames[0];
            const capture = first && {
                ...first.roi,
                quantityBounds: first.observation.fingerprint.digits?.bounds,
                itemBounds: first.observation.fingerprint.digits?.itemBounds,
            };
            const quantityCrop = quantityImage(capture);
            const itemCrop = learnableImages(capture)?.item;
            const quantity = quantityCrop ? model.suggest(quantityCrop, profile)?.quantity : undefined;
            const itemName = itemCrop ? model.suggestItem(itemCrop, profile, dictionary)?.itemName : undefined;
            const recovery = frames.length
                ? suggestUnresolvedQuantity(frames, readings, dictionary, profile, model)
                : undefined;
            if (result.status !== "recognized") {
                report.unresolved.push({
                    firstBatchId,
                    status: result.status,
                    reason: result.reason,
                    prefill: { itemName: itemName ?? null, quantity: quantity ?? null },
                    recovery: recovery ?? null,
                });
                return;
            }
            // Recognized OCR is the label. Scoring every event measures the matcher on real crops, as if a user had
            // confirmed every drop; real users only confirm unresolved ones.
            score(report.prefill.quantity, quantity, result.quantity);
            score(report.prefill.item, itemName, result.itemName);
            if (recovery?.automatic) {
                if (recovery.itemName === result.itemName && recovery.quantity === result.quantity)
                    report.automatic.correct += 1;
                else {
                    report.automatic.wrong += 1;
                    report.automatic.wrongEvents.push({
                        firstBatchId,
                        expected: { itemName: result.itemName, quantity: result.quantity },
                        recovered: { itemName: recovery.itemName, quantity: recovery.quantity },
                    });
                }
            }
            if (capture) teach(capture, { itemName: result.itemName, quantity: result.quantity });
        },
        report() {
            return {
                ...report,
                examples: examples.length,
                evidence: model.evidence.map(
                    ({ kind, label, checked, correct, alternativesCorrect, wrong, eligible }) =>
                        `${kind}:${label} checks ${correct}/${checked} others ${alternativesCorrect} wrong ${wrong}${eligible ? " eligible" : ""}`,
                ),
            };
        },
    };
}
