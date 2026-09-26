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
export type LearningProfileImage = {
    profile: LearningProfile;
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
    const bounds = capture?.quantityBounds;
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
        right - left > 64 ||
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
function shape(image: { width: number; height: number; pixels: ArrayLike<number> }): Shape | undefined {
    const { width, height, pixels } = image;
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 64 ||
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

type PreparedExample = { example: QuantityExample; shape: Shape; key: string };

export function correctionQuantityExample(
    review: LiveLootReviewEntry,
    quantity: number,
): QuantityExampleInput | undefined {
    if (
        review.accepted ||
        review.source !== "normal" ||
        (review.result.status !== "withheld" && review.result.status !== "failed") ||
        !review.learningId ||
        !review.learningProfile ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
    )
        return undefined;
    const image = quantityImage(review.result.capture);
    if (!image || !shape(image)) return undefined;
    return {
        ...image,
        pixels: Array.from(image.pixels),
        profile: review.learningProfile,
        id: review.learningId,
        quantity,
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
        .filter((entry) => entry.key === key && !entry.example.validation)
        .map((entry) => ({ quantity: entry.example.quantity, distance: distance(target, entry.shape) }))
        .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (!best || best.distance > 0.12) return undefined;
    const competitor = ranked.find((entry) => entry.quantity !== best.quantity);
    if (competitor && competitor.distance - best.distance < 0.06) return undefined;
    return {
        quantity: best.quantity,
        support: ranked.filter((entry) => entry.quantity === best.quantity && entry.distance <= 0.12).length,
    };
}

export function prepareQuantityLearning(state: QuantityLearning) {
    const examples: PreparedExample[] = [];
    for (const example of state.enabled ? state.examples.slice(0, 200) : []) {
        const prepared = shape(example);
        if (prepared) examples.push({ example, shape: prepared, key: profileKey(example.profile) });
    }
    const eligible = new Set<string>();
    const keys = new Set(examples.map((entry) => entry.key));
    for (const key of keys) {
        const validation = examples.filter((entry) => entry.key === key && entry.example.validation);
        const checked = validation.map((entry) => ({
            actual: entry.example.quantity,
            predicted: matchShape(entry.shape, key, examples)?.quantity,
        }));
        // Reserved examples never enter the matcher. Any wrong prediction blocks this setup's automatic mode.
        if (checked.some((entry) => entry.predicted !== undefined && entry.predicted !== entry.actual)) continue;
        for (const quantity of new Set(checked.map((entry) => entry.actual))) {
            const own = checked.filter((entry) => entry.actual === quantity);
            if (
                own.length >= 3 &&
                own.every((entry) => entry.predicted === quantity) &&
                checked.some((entry) => entry.actual !== quantity && entry.predicted === entry.actual)
            )
                eligible.add(`${key}/${quantity}`);
        }
    }
    return {
        enabled: state.enabled,
        eligibleCount: eligible.size,
        suggest(image: LootRoiFrame, profile: LearningProfile) {
            if (!state.enabled) return undefined;
            const target = shape(image);
            if (!target) return undefined;
            const key = profileKey(profile);
            const match = matchShape(target, key, examples);
            return (
                match && {
                    quantity: match.quantity,
                    automatic: state.autoAllow && match.support >= 2 && eligible.has(`${key}/${match.quantity}`),
                }
            );
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
        const bounds = frame.observation.fingerprint.digits?.bounds;
        const image = quantityImage({ ...frame.roi, quantityBounds: bounds });
        return image ? model.suggest(image, profile) : undefined;
    });
    const first = matches.find((match) => match !== undefined);
    if (!first || matches.some((match) => match && match.quantity !== first.quantity)) return undefined;
    const items = readings.map((passes) => {
        const parsed = passes.map((text) => clearItem(text, dictionary));
        const firstItem = parsed.find((item) => item !== undefined);
        return firstItem && parsed.filter((item) => item === firstItem).length > passes.length / 2
            ? firstItem
            : undefined;
    });
    const itemName = items[0];
    const conflict = readings.flat().some((text) => {
        const quantity = parseLootQuantity(text);
        const item = clearItem(text, dictionary);
        return (
            (quantity !== null && quantity !== first.quantity) ||
            (item !== undefined && itemName !== undefined && item !== itemName)
        );
    });
    const automatic =
        frames.length >= 3 &&
        readings.length === frames.length &&
        matches.every((match) => match?.automatic && match.quantity === first.quantity) &&
        !!itemName &&
        items.every((item) => item === itemName) &&
        !conflict;
    return { quantity: first.quantity, itemName: itemName ?? null, automatic };
}
