import {
    type LiveLootOcrFrame,
    type LootFrameEvidence,
    type LootQuantitySuggestion,
    type LootReviewCapture,
    type LootRoiFrame,
    parseLootQuantity,
} from "./liveLoot";
import type { LiveLootReviewEntry } from "./liveLootReview";
import type { LootFont } from "./lootFont";

export type LearningProfile = {
    font: LootFont;
    uiScalePercent: 80 | 100;
    sourceWidth: number;
    sourceHeight: number;
};
export type QuantityExampleInput = LearningProfileImage & {
    id: string;
    quantity: number;
    itemName?: string | null;
    itemImage?: LearningImage | null;
    originalQuantity: number | null;
    originalText: string;
    audit?: QuantityLearningAudit | null;
};
export type QuantityLearningAudit = {
    version: 1;
    sessionId: string | null;
    generation: number | null;
    eventId: string;
    status: "withheld" | "failed";
    reason: string;
    cropFrame: LootFrameEvidence;
    frames: LootFrameEvidence[];
};
export type LearningProfileImage = LearningImage & { profile: LearningProfile };
export type LearningImage = {
    width: number;
    height: number;
    pixels: number[];
};
export type QuantityExample = QuantityExampleInput & { confirmedAt: number; validation: boolean };
export type QuantityLearning = { enabled: boolean; autoAllow: boolean; examples: QuantityExample[] };
export const emptyQuantityLearning: QuantityLearning = { enabled: false, autoAllow: false, examples: [] };

function profileKey(profile: LearningProfile) {
    return `${profile.font}/${profile.uiScalePercent}/${profile.sourceWidth}/${profile.sourceHeight}`;
}

export function quantityImage(capture: LootReviewCapture | undefined): LootRoiFrame | undefined {
    return cropImage(capture, capture?.quantityBounds, 64);
}

export function itemImage(capture: LootReviewCapture | undefined): LootRoiFrame | undefined {
    return cropImage(capture, capture?.itemBounds, 512);
}

/** The crops a confirmed correction would save, using the same checks as `correctionQuantityExample`. */
export function learnableImages(capture: LootReviewCapture | undefined) {
    const quantity = quantityImage(capture);
    if (!quantity || !shape(quantity)) return undefined;
    const item = itemImage(capture);
    return { quantity, item: item && shape(item, 512) ? item : undefined };
}

function cropImage(
    capture: LootReviewCapture | undefined,
    bounds: LootReviewCapture["quantityBounds"],
    maxWidth: number,
): LootRoiFrame | undefined {
    if (!capture || !bounds) return undefined;
    const { left, right, top, bottom } = bounds;
    if (
        ![left, right, top, bottom].every(Number.isInteger) ||
        left < 0 ||
        top < 0 ||
        right > capture.width ||
        bottom > capture.height ||
        right <= left ||
        bottom <= top ||
        right - left > maxWidth ||
        bottom - top > 32
    )
        return undefined;
    const width = right - left;
    const height = bottom - top;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const start = ((y + top) * capture.width + left) * 4;
        pixels.set(capture.pixels.subarray(start, start + width * 4), y * width * 4);
    }
    return { width, height, pixels };
}

type Shape = { width: number; height: number; ink: Float32Array; norm: number };
function shape(image: { width: number; height: number; pixels: ArrayLike<number> }, maxWidth = 64): Shape | undefined {
    const { width, height, pixels } = image;
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > maxWidth ||
        height > 32 ||
        pixels.length !== width * height * 4
    )
        return undefined;
    const gray = new Float32Array(width * height);
    let left = width,
        right = -1,
        top = height,
        bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const r = pixels[offset],
                g = pixels[offset + 1],
                b = pixels[offset + 2];
            const light = (r * 77 + g * 150 + b * 29) / 256;
            const value =
                Math.max(r, g, b) - Math.min(r, g, b) > 65 ? 0 : Math.max(0, Math.min(1, (light - 110) / 125));
            gray[y * width + x] = value;
            if (value >= 0.3) {
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
            }
        }
    }
    if (right < left || bottom < top) return undefined;
    const w = right - left + 1,
        h = bottom - top + 1;
    const ink = new Float32Array(w * h);
    let norm = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const value = gray[(top + y) * width + left + x];
            ink[y * w + x] = value;
            norm += value * value;
        }
    }
    return norm < 6 ? undefined : { width: w, height: h, ink, norm: Math.sqrt(norm) };
}

function distance(a: Shape, b: Shape) {
    if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) return 1;
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            let dot = 0;
            for (let y = 0; y < a.height; y++) {
                if (y + dy < 0 || y + dy >= b.height) continue;
                for (let x = 0; x < a.width; x++) {
                    if (x + dx >= 0 && x + dx < b.width)
                        dot += a.ink[y * a.width + x] * b.ink[(y + dy) * b.width + x + dx];
                }
            }
            best = Math.max(best, dot / (a.norm * b.norm));
        }
    }
    return Math.max(0, 1 - best);
}

type PreparedExample = {
    label: string;
    shape: Shape;
    key: string;
    validation: boolean;
};
export type LearningEvidence = {
    profile: LearningProfile;
    kind: "item" | "quantity";
    label: string;
    templates: number;
    checked: number;
    correct: number;
    alternativesCorrect: number;
    wrong: number;
    eligible: boolean;
};

export function correctionQuantityExample(
    review: LiveLootReviewEntry,
    quantity: number,
    itemName: string,
): QuantityExampleInput | undefined {
    if (
        review.accepted ||
        review.source !== "normal" ||
        (review.result.status !== "withheld" && review.result.status !== "failed") ||
        !review.learningId ||
        !review.learningProfile ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !itemName.trim() ||
        itemName.trim().length > 160
    )
        return undefined;
    const image = quantityImage(review.result.capture);
    if (!image || !shape(image)) return undefined;
    const nameImage = itemImage(review.result.capture);
    return {
        ...image,
        pixels: Array.from(image.pixels),
        profile: review.learningProfile,
        id: review.learningId,
        quantity,
        itemName: itemName.trim(),
        itemImage: nameImage && shape(nameImage, 512) ? { ...nameImage, pixels: Array.from(nameImage.pixels) } : null,
        originalQuantity: review.result.quantity,
        originalText: review.result.capture?.originalText ?? "",
        audit: review.result.capture?.sourceFrame
            ? {
                  version: 1,
                  sessionId: review.learningContext?.sessionId ?? null,
                  generation: review.learningContext?.generation ?? null,
                  eventId: review.result.eventId,
                  status: review.result.status,
                  reason: review.result.reason,
                  cropFrame: review.result.capture.sourceFrame,
                  frames: review.result.capture.ocrFrames ?? [],
              }
            : null,
    };
}

function matchShape(target: Shape, key: string, examples: PreparedExample[]) {
    const ranked = examples
        .filter((entry) => entry.key === key && !entry.validation)
        .map((entry) => ({ label: entry.label, distance: distance(target, entry.shape) }))
        .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (!best || best.distance > 0.12) return undefined;
    const competitor = ranked.find((entry) => entry.label !== best.label);
    if (competitor && competitor.distance - best.distance < 0.06) return undefined;
    return {
        label: best.label,
        support: ranked.filter((entry) => entry.label === best.label && entry.distance <= 0.12).length,
    };
}

export function prepareQuantityLearning(state: QuantityLearning) {
    const evidence: LearningEvidence[] = [];
    function prepare(kind: "item" | "quantity") {
        const examples: PreparedExample[] = [];
        const profiles = new Map<string, LearningProfile>();
        // A repeated component image cannot become both a template and a validation example,
        // or count as additional support just because the other component changed.
        const images = new Map<string, PreparedExample>();
        // Persistence returns newest insertion first. Wall-clock changes must not change a component
        // from a template into a validation example (or the reverse).
        for (const example of [...(state.enabled ? state.examples.slice(0, 200) : [])].reverse()) {
            const image = kind === "item" ? example.itemImage : example;
            const label = kind === "item" ? example.itemName : String(example.quantity);
            if (!image || !label) continue;
            const prepared = shape(image, kind === "item" ? 512 : 64);
            if (!prepared) continue;
            const key = profileKey(example.profile);
            profiles.set(key, example.profile);
            const imageKey = `${key}/${image.width}/${image.height}/${image.pixels.join(",")}`;
            const previous = images.get(imageKey);
            if (previous) {
                // Preserve contradictory labels so matching abstains, including malformed imported libraries.
                if (previous.label !== label) examples.push({ ...previous, label, validation: false });
                continue;
            }
            const entry = {
                label,
                shape: prepared,
                key,
                validation: example.validation,
            };
            images.set(imageKey, entry);
            examples.push(entry);
        }
        const eligible = new Set<string>();
        for (const [key, profile] of profiles) {
            const checked = examples
                .filter((entry) => entry.key === key && entry.validation)
                .map((entry) => ({ actual: entry.label, predicted: matchShape(entry.shape, key, examples)?.label }));
            const wrong = checked.filter(
                (entry) => entry.predicted !== undefined && entry.predicted !== entry.actual,
            ).length;
            for (const label of new Set(examples.filter((entry) => entry.key === key).map((entry) => entry.label))) {
                const own = checked.filter((entry) => entry.actual === label);
                const templates = examples.filter(
                    (entry) => entry.key === key && entry.label === label && !entry.validation,
                ).length;
                const correct = own.filter((entry) => entry.predicted === label).length;
                const alternativesCorrect = checked.filter(
                    (entry) => entry.actual !== label && entry.predicted === entry.actual,
                ).length;
                const qualifies =
                    templates >= 2 &&
                    own.length >= 3 &&
                    correct === own.length &&
                    alternativesCorrect >= 1 &&
                    wrong === 0;
                if (qualifies) eligible.add(`${key}/${label}`);
                evidence.push({
                    profile,
                    kind,
                    label,
                    templates,
                    checked: own.length,
                    correct,
                    alternativesCorrect,
                    wrong,
                    eligible: qualifies,
                });
            }
        }
        return (image: LootRoiFrame, profile: LearningProfile) => {
            if (!state.enabled) return undefined;
            const target = shape(image, kind === "item" ? 512 : 64);
            if (!target) return undefined;
            const key = profileKey(profile);
            const match = matchShape(target, key, examples);
            return (
                match && {
                    label: match.label,
                    automatic: state.autoAllow && match.support >= 2 && eligible.has(`${key}/${match.label}`),
                }
            );
        };
    }
    const quantity = prepare("quantity");
    const item = prepare("item");
    return {
        enabled: state.enabled,
        evidence,
        eligibleCount: evidence.filter((entry) => entry.eligible).length,
        suggest(image: LootRoiFrame, profile: LearningProfile) {
            const match = quantity(image, profile);
            return match && { quantity: Number(match.label), automatic: match.automatic };
        },
        suggestItem(image: LootRoiFrame, profile: LearningProfile, dictionary: readonly string[]) {
            const match = item(image, profile);
            return match && dictionary.includes(match.label)
                ? { itemName: match.label, automatic: match.automatic }
                : undefined;
        },
    };
}

/** Only exact dictionary names with an explicit quantity marker can establish item evidence for auto recovery. */
function clearItem(text: string, dictionary: readonly string[]) {
    const name = text.match(/^(.*?)\s+x\s*\S*\s*$/i)?.[1];
    if (!name) return undefined;
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matches = dictionary.filter((item) => normalize(item) === normalize(name));
    return matches.length === 1 ? matches[0] : undefined;
}

export function suggestUnresolvedQuantity(
    frames: readonly LiveLootOcrFrame[],
    readings: readonly (readonly string[])[],
    dictionary: readonly string[],
    profile: LearningProfile,
    model: ReturnType<typeof prepareQuantityLearning>,
): LootQuantitySuggestion | undefined {
    if (!model.enabled) return undefined;
    const matches = frames.map((frame) => {
        const digits = frame.observation.fingerprint.digits;
        const capture = { ...frame.roi, quantityBounds: digits?.bounds, itemBounds: digits?.itemBounds };
        const number = quantityImage(capture);
        const name = itemImage(capture);
        return {
            quantity: number ? model.suggest(number, profile) : undefined,
            item: name ? model.suggestItem(name, profile, dictionary) : undefined,
        };
    });
    const firstQuantity = matches.find((match) => match.quantity)?.quantity;
    const firstItem = matches.find((match) => match.item)?.item;
    if (!firstQuantity && !firstItem) return undefined;
    if (
        matches.some(
            (match) =>
                (match.quantity && firstQuantity && match.quantity.quantity !== firstQuantity.quantity) ||
                (match.item && firstItem && match.item.itemName !== firstItem.itemName),
        )
    )
        return undefined;
    function majority<T>(values: (T | null | undefined)[]): T | undefined {
        return (
            values.find(
                (value) => value != null && values.filter((other) => other === value).length > values.length / 2,
            ) ?? undefined
        );
    }
    const ocrItems = readings.map((passes) => majority(passes.map((text) => clearItem(text, dictionary))));
    const ocrQuantities = readings.map((passes) => majority(passes.map(parseLootQuantity)));
    const itemName = firstItem?.itemName ?? ocrItems[0] ?? null;
    const quantity = firstQuantity?.quantity ?? ocrQuantities[0] ?? null;
    const allReadings = [
        ...readings.flat(),
        ...frames.flatMap((frame) =>
            (frame.diagnostics?.passes ?? []).map((pass) =>
                pass.region === "quantity" ? `x ${pass.text}` : pass.text,
            ),
        ),
    ];
    const conflict = allReadings.some((text) => {
        const number = parseLootQuantity(text);
        const item = clearItem(text, dictionary);
        return (
            (number !== null && quantity !== null && number !== quantity) ||
            (item !== undefined && itemName !== null && item !== itemName)
        );
    });
    const automatic =
        frames.length >= 3 &&
        readings.length === frames.length &&
        !!itemName &&
        quantity !== null &&
        !conflict &&
        matches.every(
            (match, index) =>
                (firstQuantity
                    ? match.quantity?.automatic && match.quantity.quantity === quantity
                    : ocrQuantities[index] === quantity) &&
                (firstItem ? match.item?.automatic && match.item.itemName === itemName : ocrItems[index] === itemName),
        );
    return { quantity, itemName, automatic };
}
