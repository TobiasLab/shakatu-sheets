import { normalLootColumn } from "./displayCapture";
import { type LootRowAppearance, lootRowAppearances } from "./lootArrival";
import type { LootSampleFps } from "./lootCaptureTiming";
import type { LootFont } from "./lootFont";
import { chroma, isGlyphPixel, luminance } from "./lootPixels";
import { type LootQuantityGlyphs, locateLootQuantity, lootQuantityDistance } from "./lootQuantity";
import { analyzeLootReadings } from "./lootReadings";
import { LootRowTracker, selectLootOcrObservations } from "./lootRowTracker";

export type LootRoiFrame = {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
    sample?: { captureToken: number; collectionPath: string; batchId: number };
    captureBatch?: { captureToken: number; batchId: number };
};

export type LootDetectionProfile = {
    width: number;
    height: number;
    maxRows: number;
    bottomCenter: number;
    spacing: number;
    rowThreshold: number;
    pixelScale?: 1 | 1.25;
};

export type LootFingerprint = {
    full: Uint8Array;
    quantity: Uint8Array;
    textGap?: number;
    ocrExtent?: number;
    digits?: LootQuantityGlyphs;
};

export type LootRowObservation<TFingerprint = LootFingerprint> = {
    slot: number;
    centerY: number;
    score: number;
    quality?: number;
    fingerprint: TFingerprint;
};

export type LootDetectedRows<TFingerprint = LootFingerprint> = {
    count: number;
    appearances?: LootRowAppearance[];
    strength: number;
    fingerprint?: TFingerprint;
    fingerprints: TFingerprint[];
    observations: LootRowObservation<TFingerprint>[];
};

export type LootTrack<TFingerprint = LootFingerprint> = {
    id: string;
    firstFrame: number;
    baseline: boolean;
    observations: Array<LootRowObservation<TFingerprint> & { frame: number }>;
};

export type LootRecognitionResult = {
    eventId: string;
    firstFrame: number;
    selectedFrames: number[];
    itemName: string | null;
    quantity: number | null;
};

type LiveLootEventResultBase = LootRecognitionResult & {
    capture?: LootReviewCapture;
    quantitySuggestion?: LootQuantitySuggestion;
    learnedQuantity?: boolean;
    status: "recognized" | "withheld" | "failed";
    reason:
        | null
        | "insufficient-observations"
        | "item-not-recognized"
        | "quantity-not-recognized"
        | "consensus-withheld"
        | "ocr-failure";
};

export type LiveLootEventResult =
    | (LiveLootEventResultBase & {
          status: "recognized";
          reason: null;
          itemName: string;
          quantity: number;
      })
    | (LiveLootEventResultBase & {
          status: "withheld";
          reason:
              | "insufficient-observations"
              | "item-not-recognized"
              | "quantity-not-recognized"
              | "consensus-withheld";
          itemName: null;
          quantity: null;
      })
    | (LiveLootEventResultBase & {
          status: "failed";
          reason: "ocr-failure";
          itemName: null;
          quantity: null;
      });

export type LiveLootOverflowSummary = {
    eventId: null;
    firstFrame: number;
    selectedFrames: [];
    itemName: null;
    quantity: null;
    status: "dropped";
    reason: "backpressure-summary" | "result-overflow-summary" | "mixed-overflow-summary";
    count: number;
    backpressureCount: number;
    resultOverflowCount: number;
    firstEventId: string;
    lastEventId: string;
    lastFrame: number;
};

export type LiveLootRecognitionResult = LiveLootEventResult | LiveLootOverflowSummary;

export type LootOcrPass = {
    threshold: 130 | 150 | 170;
    scale: 2 | 4;
    region: "line" | "quantity";
    text: string;
};

export type LiveLootOcrFrame = {
    eventId?: string;
    frame: number;
    roi: LootRoiFrame;
    observation: LootRowObservation<LootFingerprint>;
    bounds?: LootOcrBounds;
    textColor?: "white" | "gold";
    diagnostics?: { passes: LootOcrPass[] };
};

export type LootQuantitySuggestion = { quantity: number | null; itemName: string | null; automatic: boolean };
export type LootReviewCapture = LootRoiFrame & {
    bounds?: LootOcrBounds;
    quantityBounds?: LootOcrBounds;
    itemBounds?: LootOcrBounds;
    originalText?: string;
    sourceFrame?: LootFrameEvidence;
    ocrFrames?: LootFrameEvidence[];
};

export type LootFrameEvidence = {
    frame: number;
    captureToken: number | null;
    batchId: number | null;
    roiWidth: number;
    roiHeight: number;
    quantityBounds: LootOcrBounds | null;
    itemBounds?: LootOcrBounds | null;
    readings: string[];
    passes: LootOcrPass[];
};

function frameEvidence(frame: LiveLootOcrFrame, readings: readonly string[] = []): LootFrameEvidence {
    const batch = frame.roi.captureBatch ?? frame.roi.sample;
    return {
        frame: frame.frame,
        captureToken: batch?.captureToken ?? null,
        batchId: batch?.batchId ?? null,
        roiWidth: frame.roi.width,
        roiHeight: frame.roi.height,
        quantityBounds: frame.observation.fingerprint.digits
            ? { ...frame.observation.fingerprint.digits.bounds }
            : null,
        ...(frame.observation.fingerprint.digits?.itemBounds
            ? { itemBounds: { ...frame.observation.fingerprint.digits.itemBounds } }
            : {}),
        readings: readings.slice(0, 3).map((text) => text.slice(0, 512)),
        passes: (frame.diagnostics?.passes ?? [])
            .slice(0, 9)
            .map((pass) => ({ ...pass, text: pass.text.slice(0, 512) })),
    };
}

/** Copy only the item row; never retain the full capture buffer for review. */
export function copyLootReviewCapture(frame: LiveLootOcrFrame): LootReviewCapture {
    const { roi, observation } = frame;
    const top = Math.max(0, Math.floor(frame.bounds?.top ?? observation.centerY - 24));
    const bottom = Math.min(roi.height, Math.ceil(frame.bounds?.bottom ?? observation.centerY + 24));
    const height = Math.max(1, bottom - top);
    const digits = observation.fingerprint.digits?.bounds;
    const item = observation.fingerprint.digits?.itemBounds;
    return {
        width: roi.width,
        height,
        sourceFrame: frameEvidence(frame),
        quantityBounds:
            digits && digits.top >= top && digits.bottom <= bottom
                ? { ...digits, top: digits.top - top, bottom: digits.bottom - top }
                : undefined,
        ...(item && item.top >= top && item.bottom <= bottom
            ? { itemBounds: { ...item, top: item.top - top, bottom: item.bottom - top } }
            : {}),
        pixels: roi.pixels.slice(top * roi.width * 4, (top + height) * roi.width * 4),
        bounds: {
            left: frame.bounds?.left ?? normalLootColumn(roi.width, 0.25),
            right: frame.bounds?.right ?? roi.width,
            top: frame.bounds ? 0 : Math.max(0, observation.centerY - 12 - top),
            bottom: frame.bounds ? height : Math.min(height, observation.centerY + 12 - top),
        },
    };
}

export type LootOcrBounds = { left: number; right: number; top: number; bottom: number };

export type LiveLootOcrReader = (
    frames: readonly LiveLootOcrFrame[],
    signal: AbortSignal,
) => Promise<readonly (readonly string[])[]>;

export const NORMAL_LOOT_OCR_SELECTION = { windowFrames: 6, maximumFrameCount: 5 } as const;

export type LootOcrSelectionOptions = {
    windowFrames?: number;
    frameStep?: number;
    maximumFrameCount?: number;
    frameCount?: number;
    delayFrames?: number;
};

export type LiveLootFrameAnalyzer = (frame: LootRoiFrame) => LootDetectedRows<LootFingerprint>;

export type LiveLootCoordinatorOptions = {
    font?: LootFont;
    sampleFps?: LootSampleFps;
    profile: LootDetectionProfile;
    dictionary: readonly string[];
    readText: LiveLootOcrReader;
    suggestQuantity?: (
        frames: readonly LiveLootOcrFrame[],
        readings: readonly (readonly string[])[],
    ) => LootQuantitySuggestion | undefined;
    /** Must complete synchronously. Returned thenables are treated as callback errors and are not awaited. */
    onResult: (result: LiveLootRecognitionResult) => void;
    maxPendingOcrJobs?: number;
    maxPendingResults?: number;
    retainedFrameCount?: number;
    analyzeFrame?: LiveLootFrameAnalyzer;
    ocrSelection?: Omit<LootOcrSelectionOptions, "frameStep">;
    ocrBounds?: LootOcrBounds;
    ocrTextColor?: "white" | "gold";
    eventIdPrefix?: string;
};

export type FingerprintDistance<TFingerprint> = (
    left: TFingerprint | undefined,
    right: TFingerprint | undefined,
) => number;

function validateProfile(profile: LootDetectionProfile) {
    if (
        ![profile.width, profile.height, profile.maxRows, profile.bottomCenter, profile.spacing].every(
            (value) => Number.isInteger(value) && value > 0,
        ) ||
        !Number.isFinite(profile.rowThreshold) ||
        profile.rowThreshold < 0 ||
        (profile.pixelScale !== undefined && profile.pixelScale !== 1 && profile.pixelScale !== 1.25)
    ) {
        throw new Error("Loot detection profile values are invalid.");
    }
    const topCenter = profile.bottomCenter - (profile.maxRows - 1) * profile.spacing;
    const margin = Math.round(9 * (profile.pixelScale ?? 1));
    if (topCenter < margin || profile.bottomCenter > profile.height - margin - 1) {
        throw new Error("Loot detection row geometry exceeds the ROI bounds.");
    }
}

function rowScore(frame: LootRoiFrame, centerY: number, rowThreshold: number, scale: number) {
    const halfBand = Math.round(6 * scale);
    const edge = Math.round(2 * scale);
    let score = 0;
    let textScore = 0;
    let surrounding = 0;
    let surroundingRows = 0;
    const left = normalLootColumn(frame.width, 0.22);
    const right = normalLootColumn(frame.width, 0.96);
    const textLeft = normalLootColumn(frame.width, 0.27);
    const textRight = normalLootColumn(frame.width, 0.58);
    for (let y = centerY - halfBand; y <= centerY + halfBand; y += 1) {
        for (let x = left; x < right; x += 1) {
            if (!isGlyphPixel(frame.pixels, frame.width, (y * frame.width + x) * 4, false, scale)) continue;
            score += 1;
            if (x >= textLeft && x < textRight) {
                if (isGlyphPixel(frame.pixels, frame.width, (y * frame.width + x) * 4, true, scale)) textScore += 1;
            }
        }
    }
    for (const delta of [-9, -8, 8, 9]) {
        const y = centerY + Math.round(delta * scale);
        if (y < edge || y >= frame.height - edge) continue;
        surroundingRows += 1;
        for (let x = textLeft; x < textRight; x += 1) {
            if (isGlyphPixel(frame.pixels, frame.width, (y * frame.width + x) * 4, true, scale)) surrounding += 1;
        }
    }
    // Compare the start of the text with its margins, away from the icon and exposed scenery.
    return textScore >= Math.max(1, rowThreshold / 4) &&
        textScore * surroundingRows >= surrounding * (2 * halfBand + 1) * 1.5
        ? score
        : 0;
}

function rowFingerprint(frame: LootRoiFrame, centerY: number, scale: number, font: LootFont): LootFingerprint {
    const halfBand = Math.round(6 * scale);
    const left = normalLootColumn(frame.width, 0.27);
    const right = normalLootColumn(frame.width, 0.96);
    const quantityLeft = normalLootColumn(frame.width, 0.58);

    function project(startX: number, maximumChroma = 25) {
        const projection = new Uint8Array(right - startX);
        for (let x = startX; x < right; x += 1) {
            let brightPixels = 0;
            for (let y = centerY - halfBand; y <= centerY + halfBand; y += 1) {
                const offset = (y * frame.width + x) * 4;
                if (
                    luminance(frame.pixels, offset) >= 150 &&
                    chroma(frame.pixels, offset) <= maximumChroma &&
                    isGlyphPixel(frame.pixels, frame.width, offset, false, scale)
                )
                    brightPixels += 1;
            }
            projection[x - startX] = brightPixels;
        }
        return projection;
    }

    const full = project(left);
    return {
        full,
        quantity: full.slice(quantityLeft - left),
        textGap: Math.round(8 * scale),
        ...(font === "strong-sword" ? { ocrExtent: lootTextExtent(project(left, 55), Math.round(8 * scale)) } : {}),
        digits: locateLootQuantity(frame, centerY, full, scale, font),
    };
}

export function analyzeLootRoiFrame(
    frame: LootRoiFrame,
    profile: LootDetectionProfile,
    font: LootFont = "korean",
): LootDetectedRows<LootFingerprint> {
    validateProfile(profile);
    if (frame.width !== profile.width || frame.height !== profile.height) {
        throw new Error(`Loot ROI must be ${profile.width}x${profile.height} pixels.`);
    }
    if (frame.pixels.length !== frame.width * frame.height * 4) {
        throw new Error("Loot ROI pixels must be tightly packed RGBA data.");
    }

    const scale = profile.pixelScale ?? 1;
    const scores = Array.from({ length: profile.maxRows }, (_, slot) =>
        rowScore(
            frame,
            profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing,
            profile.rowThreshold,
            scale,
        ),
    );
    const detected = scores.map((score) => score >= profile.rowThreshold);
    let count = 0;
    for (let slot = profile.maxRows - 1; slot >= 0 && detected[slot]; slot -= 1) count += 1;
    const fingerprints = Array.from({ length: count }, (_, index) =>
        rowFingerprint(frame, profile.bottomCenter - (count - index - 1) * profile.spacing, scale, font),
    );
    const observations: LootRowObservation<LootFingerprint>[] = [];
    for (let slot = profile.maxRows - count; slot < profile.maxRows; slot += 1) {
        observations.push({
            slot,
            centerY: profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing,
            score: scores[slot],
            quality:
                fingerprints[slot - (profile.maxRows - count)].full.reduce((sum, value) => sum + value, 0) /
                scores[slot],
            fingerprint: fingerprints[slot - (profile.maxRows - count)],
        });
    }

    return {
        appearances: count > 0 ? lootRowAppearances(frame, profile) : undefined,
        count,
        strength: scores.slice(profile.maxRows - count).reduce((total, score) => total + score, 0),
        fingerprint: fingerprints[count - 1],
        fingerprints,
        observations,
    };
}

function lootTextExtent(projection: Uint8Array, textGap = 8) {
    let seenGlyph = false;
    let gap = 0;
    for (let index = 0; index < projection.length; index += 1) {
        if (projection[index] > 0) {
            seenGlyph = true;
            gap = 0;
        } else if (seenGlyph && ++gap >= textGap) {
            return index + 1;
        }
    }
    return projection.length;
}

export function lootFingerprintDistance(left: LootFingerprint | undefined, right: LootFingerprint | undefined) {
    if (!left || !right) return 0;

    // Use either row's trailing whitespace to exclude scenery. Include the gap itself so an extra quantity digit
    // still changes identity (for example x 9 versus x 90).
    const extent = Math.min(lootTextExtent(left.full, left.textGap), lootTextExtent(right.full, right.textGap));
    function cosineDistance(leftProjection: Uint8Array, rightProjection: Uint8Array, length: number) {
        if (leftProjection.length !== rightProjection.length) return 1;
        let dot = 0;
        let leftLength = 0;
        let rightLength = 0;
        for (let index = 0; index < length; index += 1) {
            dot += leftProjection[index] * rightProjection[index];
            leftLength += leftProjection[index] ** 2;
            rightLength += rightProjection[index] ** 2;
        }
        if (leftLength === 0 || rightLength === 0) return leftLength === rightLength ? 0 : 1;
        return 1 - dot / Math.sqrt(leftLength * rightLength);
    }

    return Math.max(
        cosineDistance(left.full, right.full, extent),
        cosineDistance(left.quantity, right.quantity, Math.max(0, extent - (left.full.length - left.quantity.length))),
    );
}

function lootQuantityIdentityDistance(left: LootFingerprint | undefined, right: LootFingerprint | undefined) {
    if (!left?.digits || !right?.digits) return 0;
    // Fading erases strokes across the whole row. Only compare digit shapes while the name has stable ink.
    const nameExtent = Math.min(left.full.length - left.quantity.length, right.full.length - right.quantity.length);
    const leftInk = left.full.subarray(0, nameExtent).reduce((sum, value) => sum + value, 0);
    const rightInk = right.full.subarray(0, nameExtent).reduce((sum, value) => sum + value, 0);
    if (Math.min(leftInk, rightInk) < Math.max(leftInk, rightInk) * 0.9) return 0;
    return lootQuantityDistance(left.digits, right.digits);
}

export function lootRowIdentityDistance(left: LootFingerprint | undefined, right: LootFingerprint | undefined) {
    const projectionDistance = lootFingerprintDistance(left, right);
    // Do not let a small, noisy digit crop displace a near-identical whole-row match.
    return projectionDistance <= 0.01
        ? projectionDistance
        : Math.max(projectionDistance, lootQuantityIdentityDistance(left, right));
}

const defaultRetainedFrameCount = 4;
const defaultMaxPendingResults = 16;

type LootResultMetadata = {
    eventId: string;
    firstFrame: number;
    selectedFrames: number[];
};

type LootOcrDelivery = LootResultMetadata & {
    activeFrames?: LiveLootOcrFrame[];
    kind: "ocr";
    frames: LiveLootOcrFrame[];
    generation: number;
    counted: boolean;
};

type LootResultDelivery = {
    kind: "result";
    result: LiveLootEventResult;
    generation: number;
};

type LootSummaryDelivery = {
    kind: "summary";
    result: LiveLootOverflowSummary;
    generation: number;
};

type LootDelivery = LootOcrDelivery | LootResultDelivery | LootSummaryDelivery;

export class LiveLootCoordinator {
    private readonly tracker: LootRowTracker<LootFingerprint>;
    private readonly frames = new Map<number, LootRoiFrame>();
    private readonly candidates = new Set<LootTrack<LootFingerprint>>();
    private readonly deliveries: LootDelivery[] = [];
    private readonly abortController = new AbortController();
    private readonly analyzeFrame: LiveLootFrameAnalyzer;
    private readonly ocrSelection: LootOcrSelectionOptions;
    private readonly ocrFrameCount: number;
    private pendingSummary: LootSummaryDelivery | undefined;
    private activeOcrDelivery: LootOcrDelivery | undefined;
    private state: "active" | "finishing" | "finished" | "stopped" = "active";
    private nextFrame = 0;
    private pendingOcrJobs = 0;
    private pendingResultEntries = 0;
    private draining = false;
    private deliveringCallback = false;
    private generation = 0;
    private finishPromise: Promise<void> | undefined;
    private finishResolve: (() => void) | undefined;
    private finishReject: ((reason?: unknown) => void) | undefined;
    private finishSettled = false;
    private callbackFailed = false;
    private callbackError: unknown;
    private finishFailed = false;
    private finishError: unknown;

    constructor(private readonly options: LiveLootCoordinatorOptions) {
        validateProfile(options.profile);
        const maxPendingOcrJobs = options.maxPendingOcrJobs ?? 2;
        const maxPendingResults = options.maxPendingResults ?? defaultMaxPendingResults;
        const sampleFps = options.sampleFps ?? 8;
        if (sampleFps !== 8 && sampleFps !== 16) throw new Error("Loot sampling must be 8 or 16 FPS.");
        const frameStep = sampleFps / 8;
        const windowFrames = options.ocrSelection?.windowFrames ?? options.ocrSelection?.frameCount ?? 3;
        const observationWindow = (windowFrames - 1) * frameStep + 1;
        const retainedFrameCount =
            options.retainedFrameCount ?? Math.max(defaultRetainedFrameCount * frameStep, observationWindow + 1);
        const ocrFrameCount = options.ocrSelection?.frameCount ?? 3;
        const maximumFrameCount = options.ocrSelection?.maximumFrameCount ?? ocrFrameCount;
        if (
            !Number.isInteger(maximumFrameCount) ||
            maximumFrameCount < ocrFrameCount ||
            maximumFrameCount > Math.min(windowFrames, 5)
        ) {
            throw new Error(
                "Maximum selected OCR frames must cover the minimum and fit within the window (at most five).",
            );
        }
        const delayFrames = (options.ocrSelection?.delayFrames ?? 1) * frameStep;
        if (!Number.isInteger(maxPendingOcrJobs) || maxPendingOcrJobs < 1) {
            throw new Error("Maximum pending loot OCR jobs must be a positive integer.");
        }
        if (!Number.isInteger(retainedFrameCount) || retainedFrameCount < defaultRetainedFrameCount) {
            throw new Error(`Retained loot frame count must be at least ${defaultRetainedFrameCount}.`);
        }
        if (!Number.isInteger(maxPendingResults) || maxPendingResults < 1) {
            throw new Error("Maximum pending loot results must be a positive integer.");
        }
        if (!Number.isInteger(ocrFrameCount) || ocrFrameCount < 2) {
            throw new Error("Loot OCR frame count must be an integer of at least two for temporal consensus.");
        }
        if (!Number.isInteger(delayFrames) || delayFrames < 0) {
            throw new Error("Loot OCR frame delay must be a non-negative integer.");
        }
        if (!Number.isInteger(windowFrames) || windowFrames < ocrFrameCount || windowFrames > 6) {
            throw new Error("Loot OCR selection window must cover its frame count and contain at most six frames.");
        }
        if (retainedFrameCount < observationWindow + 1) {
            throw new Error("Retained loot frame count must cover selected OCR frames and birth confirmation.");
        }
        const bounds = options.ocrBounds;
        if (
            bounds &&
            (!Number.isInteger(bounds.left) ||
                !Number.isInteger(bounds.right) ||
                !Number.isInteger(bounds.top) ||
                !Number.isInteger(bounds.bottom) ||
                bounds.left < 0 ||
                bounds.left >= bounds.right ||
                bounds.right > options.profile.width ||
                bounds.top < 0 ||
                bounds.top >= bounds.bottom ||
                bounds.bottom > options.profile.height)
        ) {
            throw new Error("Loot OCR bounds must be valid source pixel coordinates.");
        }
        this.maxPendingOcrJobs = maxPendingOcrJobs;
        this.maxPendingResults = maxPendingResults;
        this.maximumRetainedFrames = retainedFrameCount;
        this.analyzeFrame =
            options.analyzeFrame ?? ((frame) => analyzeLootRoiFrame(frame, options.profile, options.font));
        this.ocrSelection = {
            frameCount: ocrFrameCount,
            frameStep,
            delayFrames,
            windowFrames,
            maximumFrameCount,
        };
        this.ocrFrameCount = ocrFrameCount;
        this.tracker = new LootRowTracker(options.profile.rowThreshold, lootFingerprintDistance, {
            retainHistory: false,
            identityDistance: lootRowIdentityDistance,
            maxObservationsPerTrack: observationWindow,
            emptyFrameLimit: sampleFps === 16 ? 4 : 2,
            eventIdPrefix: options.eventIdPrefix,
        });
    }

    private readonly maxPendingOcrJobs: number;
    private readonly maxPendingResults: number;
    private readonly maximumRetainedFrames: number;

    get retainedFrameCount() {
        return this.frames.size;
    }

    get retainedTrackCount() {
        return this.tracker.tracks.length;
    }

    get retainedObservationCount() {
        return this.tracker.tracks.reduce((count, track) => count + track.observations.length, 0);
    }

    get pendingCandidateCount() {
        return this.candidates.size;
    }

    get pendingOcrJobCount() {
        return this.pendingOcrJobs;
    }

    get queuedDeliveryCount() {
        return this.deliveries.length;
    }

    get queuedSummaryCount() {
        return this.deliveries.reduce((count, delivery) => count + (delivery.kind === "summary" ? 1 : 0), 0);
    }

    private resultMetadata(track: LootTrack<LootFingerprint>, selectedFrames: number[]): LootResultMetadata {
        return {
            eventId: track.id,
            firstFrame: track.firstFrame,
            selectedFrames,
        };
    }

    private emptyResult(metadata: LootResultMetadata) {
        return {
            eventId: metadata.eventId,
            firstFrame: metadata.firstFrame,
            selectedFrames: metadata.selectedFrames,
            itemName: null as null,
            quantity: null as null,
        };
    }

    private updateSummaryReason(summary: LiveLootOverflowSummary) {
        summary.reason =
            summary.backpressureCount > 0 && summary.resultOverflowCount > 0
                ? "mixed-overflow-summary"
                : summary.backpressureCount > 0
                  ? "backpressure-summary"
                  : "result-overflow-summary";
    }

    private summarize(metadata: LootResultMetadata, overflow: "backpressure" | "result") {
        if (this.pendingSummary) {
            const summary = this.pendingSummary.result;
            summary.count += 1;
            summary.lastEventId = metadata.eventId;
            summary.lastFrame = metadata.firstFrame;
            if (overflow === "backpressure") summary.backpressureCount += 1;
            else summary.resultOverflowCount += 1;
            this.updateSummaryReason(summary);
            return;
        }

        const result: LiveLootOverflowSummary = {
            eventId: null,
            firstFrame: metadata.firstFrame,
            selectedFrames: [],
            itemName: null,
            quantity: null,
            status: "dropped",
            reason: overflow === "backpressure" ? "backpressure-summary" : "result-overflow-summary",
            count: 1,
            backpressureCount: overflow === "backpressure" ? 1 : 0,
            resultOverflowCount: overflow === "result" ? 1 : 0,
            firstEventId: metadata.eventId,
            lastEventId: metadata.eventId,
            lastFrame: metadata.firstFrame,
        };
        const delivery: LootSummaryDelivery = { kind: "summary", result, generation: this.generation };
        this.pendingSummary = delivery;
        this.deliveries.push(delivery);
    }

    private queueResult(result: LiveLootEventResult) {
        const metadata = {
            eventId: result.eventId,
            firstFrame: result.firstFrame,
            selectedFrames: result.selectedFrames,
        };
        if (this.pendingResultEntries + (this.deliveringCallback ? 1 : 0) >= this.maxPendingResults) {
            this.summarize(metadata, "result");
            return;
        }
        this.pendingSummary = undefined;
        this.pendingResultEntries += 1;
        this.deliveries.push({ kind: "result", result, generation: this.generation });
    }

    private settleCandidate(track: LootTrack<LootFingerprint>, flush = false) {
        const latest = track.observations[track.observations.length - 1]?.frame ?? track.firstFrame;
        const firstEligible = track.observations.find(
            ({ frame }) => frame >= track.firstFrame + (this.ocrSelection.delayFrames ?? 1),
        );
        const expiring =
            firstEligible !== undefined && firstEligible.frame <= this.nextFrame - this.maximumRetainedFrames;
        if (
            !flush &&
            !expiring &&
            latest <
                track.firstFrame +
                    (this.ocrSelection.delayFrames ?? 1) +
                    ((this.ocrSelection.windowFrames ?? 3) - 1) * (this.ocrSelection.frameStep ?? 1)
        )
            return false;
        const selected = selectLootOcrObservations(
            { ...track, observations: track.observations.filter(({ frame }) => this.frames.has(frame)) },
            this.options.profile.rowThreshold,
            this.ocrSelection,
            lootFingerprintDistance,
        );
        if (selected.length < this.ocrFrameCount) return false;

        const metadata = this.resultMetadata(
            track,
            selected.map(({ frame }) => frame),
        );
        if (this.pendingOcrJobs >= this.maxPendingOcrJobs) {
            this.summarize(metadata, "backpressure");
        } else {
            const padding = Math.round(12 * (this.options.profile.pixelScale ?? 1));
            const normalRight = Math.min(
                normalLootColumn(this.options.profile.width, 0.96),
                ...selected
                    .slice(0, this.ocrFrameCount)
                    .map(
                        (observation) =>
                            normalLootColumn(this.options.profile.width, 0.27) +
                            (observation.fingerprint.ocrExtent ??
                                lootTextExtent(observation.fingerprint.full, observation.fingerprint.textGap)),
                    ),
            );
            const frames = selected.map((observation) => {
                const roi = this.frames.get(observation.frame);
                if (!roi) throw new Error(`Selected loot frame ${observation.frame} is no longer retained.`);
                return {
                    eventId: track.id,
                    frame: observation.frame,
                    roi,
                    observation,
                    bounds:
                        this.options.ocrBounds ??
                        (this.options.analyzeFrame === undefined
                            ? {
                                  left: normalLootColumn(roi.width, 0.25),
                                  right: normalRight,
                                  top: Math.max(0, observation.centerY - padding),
                                  bottom: Math.min(roi.height, observation.centerY + padding),
                              }
                            : undefined),
                    textColor: this.options.ocrTextColor,
                };
            });
            this.pendingSummary = undefined;
            this.pendingOcrJobs += 1;
            this.deliveries.push({ kind: "ocr", ...metadata, frames, generation: this.generation, counted: true });
        }
        this.candidates.delete(track);
        this.tracker.releaseTrack(track);
        return true;
    }

    private captureTrack(track: LootTrack<LootFingerprint>) {
        const observation = [...track.observations].reverse().find(({ frame }) => this.frames.has(frame));
        const roi = observation && this.frames.get(observation.frame);
        return observation && roi
            ? copyLootReviewCapture({ frame: observation.frame, roi, observation, bounds: this.options.ocrBounds })
            : undefined;
    }

    private processTrackerChanges() {
        for (const track of this.tracker.takeEndedTracks()) {
            if (this.candidates.has(track)) this.settleCandidate(track, true);
            if (this.candidates.delete(track)) {
                const metadata = this.resultMetadata(track, []);
                this.queueResult({
                    ...this.emptyResult(metadata),
                    status: "withheld",
                    reason: "insufficient-observations",
                    capture: this.captureTrack(track),
                });
            }
            this.tracker.releaseTrack(track);
        }
        for (const track of this.tracker.takeNewTracks()) {
            if (track.baseline) this.tracker.releaseTrack(track);
            else this.candidates.add(track);
        }
        for (const track of this.candidates) {
            this.settleCandidate(track);
        }
    }

    private recordCallbackError(error: unknown) {
        if (!this.callbackFailed) {
            this.callbackFailed = true;
            this.callbackError = error;
        }
    }

    private deliver(result: LiveLootRecognitionResult, generation: number) {
        if (this.state === "stopped" || generation !== this.generation) return;
        this.deliveringCallback = true;
        try {
            const returned = this.options.onResult(result) as unknown;
            if (
                returned !== null &&
                (typeof returned === "object" || typeof returned === "function") &&
                typeof (returned as { then?: unknown }).then === "function"
            ) {
                this.recordCallbackError(new Error("Live loot result callbacks must be synchronous."));
                void Promise.resolve(returned).catch(() => undefined);
            }
        } catch (error) {
            this.recordCallbackError(error);
        } finally {
            this.deliveringCallback = false;
            this.maybeSettleFinish();
        }
    }

    private releaseOcrDelivery(delivery: LootOcrDelivery) {
        if (delivery.activeFrames) delivery.activeFrames.length = 0;
        delivery.activeFrames = undefined;
        delivery.frames.length = 0;
        if (!delivery.counted) return;
        delivery.counted = false;
        this.pendingOcrJobs -= 1;
    }

    private async drainDeliveries() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.deliveries.length > 0 && this.state !== "stopped") {
                const delivery = this.deliveries.shift();
                if (!delivery) break;
                if (delivery.kind !== "ocr") {
                    if (delivery.kind === "summary" && this.pendingSummary === delivery) {
                        this.pendingSummary = undefined;
                    } else if (delivery.kind === "result") {
                        this.pendingResultEntries -= 1;
                    }
                    this.deliver(delivery.result, delivery.generation);
                    continue;
                }

                let result: LiveLootEventResult | undefined;
                let originalText = "";
                const readingsByFrame = new Map<number, readonly string[]>();
                this.activeOcrDelivery = delivery;
                try {
                    const primaryFrames = delivery.frames.slice(0, this.ocrFrameCount);
                    delivery.activeFrames = primaryFrames;
                    delivery.selectedFrames = primaryFrames.map(({ frame }) => frame);
                    for (const frame of primaryFrames) frame.diagnostics ??= { passes: [] };
                    let rawReadings = await this.options.readText(primaryFrames, this.abortController.signal);
                    primaryFrames.forEach((frame, index) => {
                        readingsByFrame.set(frame.frame, rawReadings[index] ?? []);
                    });
                    originalText = rawReadings[0]?.join("\n").slice(0, 3200) ?? "";
                    if (rawReadings.length !== primaryFrames.length) {
                        throw new Error("Loot OCR readings must match the selected frame count.");
                    }
                    let analysis = analyzeLootReadings(rawReadings, this.options.dictionary);
                    if (
                        !analysis.consensus &&
                        !analysis.conflicting &&
                        delivery.generation === this.generation &&
                        delivery.frames.length > primaryFrames.length
                    ) {
                        const additionalFrames = delivery.frames.slice(primaryFrames.length);
                        delivery.activeFrames = additionalFrames;
                        primaryFrames.length = 0;
                        delivery.selectedFrames.push(...additionalFrames.map(({ frame }) => frame));
                        for (const frame of additionalFrames) frame.diagnostics ??= { passes: [] };
                        const additionalReadings = await this.options.readText(
                            additionalFrames,
                            this.abortController.signal,
                        );
                        if (additionalReadings.length !== additionalFrames.length)
                            throw new Error("Loot OCR readings must match the selected frame count.");
                        additionalFrames.forEach((frame, index) => {
                            readingsByFrame.set(frame.frame, additionalReadings[index] ?? []);
                        });
                        rawReadings = [...rawReadings, ...additionalReadings];
                        analysis = analyzeLootReadings(rawReadings, this.options.dictionary);
                    }
                    if (delivery.generation === this.generation) {
                        const metadata = this.emptyResult(delivery);
                        result = analysis.consensus
                            ? {
                                  ...metadata,
                                  status: "recognized",
                                  reason: null,
                                  itemName: analysis.consensus.item,
                                  quantity: analysis.consensus.quantity,
                              }
                            : {
                                  ...metadata,
                                  status: "withheld",
                                  reason: analysis.reason,
                              };
                        if (!analysis.consensus && this.options.suggestQuantity) {
                            const suggestion = this.options.suggestQuantity(
                                delivery.frames.slice(0, rawReadings.length),
                                rawReadings,
                            );
                            result.quantitySuggestion = suggestion;
                            if (suggestion?.automatic && suggestion.itemName && suggestion.quantity !== null) {
                                result = {
                                    ...result,
                                    status: "recognized",
                                    reason: null,
                                    itemName: suggestion.itemName,
                                    quantity: suggestion.quantity,
                                    learnedQuantity: true,
                                };
                            }
                        }
                    }
                } catch {
                    result = {
                        ...this.emptyResult(delivery),
                        status: "failed",
                        reason: "ocr-failure",
                    };
                } finally {
                    if (result && result.status !== "recognized" && delivery.frames[0]) {
                        result.capture = copyLootReviewCapture(delivery.frames[0]);
                        result.capture.originalText = originalText;
                        result.capture.sourceFrame = frameEvidence(
                            delivery.frames[0],
                            readingsByFrame.get(delivery.frames[0].frame),
                        );
                        result.capture.ocrFrames = delivery.frames
                            .filter((frame) => delivery.selectedFrames.includes(frame.frame))
                            .slice(0, 5)
                            .map((frame) => frameEvidence(frame, readingsByFrame.get(frame.frame)));
                    }
                    this.releaseOcrDelivery(delivery);
                    if (this.activeOcrDelivery === delivery) this.activeOcrDelivery = undefined;
                }
                if (result) this.deliver(result, delivery.generation);
            }
        } finally {
            this.draining = false;
            this.maybeSettleFinish();
        }
    }

    private startDraining() {
        void this.drainDeliveries();
    }

    private createFinishPromise() {
        this.finishPromise = new Promise<void>((resolve, reject) => {
            this.finishResolve = resolve;
            this.finishReject = reject;
        });
        return this.finishPromise;
    }

    private maybeSettleFinish() {
        if (!this.finishPromise || this.finishSettled) return;
        if (this.deliveringCallback) return;
        if (this.state !== "stopped" && (this.state !== "finishing" || this.draining || this.deliveries.length > 0)) {
            return;
        }
        if (this.state === "finishing") this.state = "finished";
        this.finishSettled = true;
        if (this.finishFailed) this.finishReject?.(this.finishError);
        else if (this.callbackFailed) this.finishReject?.(this.callbackError);
        else this.finishResolve?.();
    }

    private finishCandidates() {
        for (const track of this.candidates) {
            if (this.settleCandidate(track, true)) continue;
            const metadata = this.resultMetadata(track, []);
            this.queueResult({
                ...this.emptyResult(metadata),
                status: "withheld",
                reason: "insufficient-observations",
                capture: this.captureTrack(track),
            });
            this.candidates.delete(track);
            this.tracker.releaseTrack(track);
        }
    }

    /**
     * Takes ownership of `frame` and its pixel buffer without copying. The caller must not mutate or reuse either
     * after this call. Ownership is released after the frame leaves the rolling store and any selected OCR job settles.
     */
    pushFrame(frame: LootRoiFrame) {
        if (this.state !== "active")
            throw new Error("Cannot push loot frames after the coordinator is stopped or finished.");
        const rows = this.analyzeFrame(frame);
        const frameNumber = this.nextFrame;
        this.nextFrame += 1;
        this.frames.set(frameNumber, frame);
        while (this.frames.size > this.maximumRetainedFrames) {
            const oldest = this.frames.keys().next().value;
            if (oldest === undefined) break;
            this.frames.delete(oldest);
        }
        this.tracker.push(rows);
        this.processTrackerChanges();
        this.startDraining();
    }

    finish(): Promise<void> {
        if (this.finishPromise) return this.finishPromise;
        const finishPromise = this.createFinishPromise();
        if (this.state === "stopped") {
            this.maybeSettleFinish();
            return finishPromise;
        }
        this.state = "finishing";
        try {
            this.tracker.finish();
            this.processTrackerChanges();
            this.finishCandidates();
        } catch (error) {
            this.finishFailed = true;
            this.finishError = error;
        }
        this.candidates.clear();
        this.tracker.clear();
        this.frames.clear();
        this.startDraining();
        this.maybeSettleFinish();
        return finishPromise;
    }

    stop() {
        if (this.state === "stopped" || this.state === "finished") return;
        this.state = "stopped";
        this.generation += 1;
        this.abortController.abort();
        if (this.activeOcrDelivery) {
            this.releaseOcrDelivery(this.activeOcrDelivery);
            this.activeOcrDelivery = undefined;
        }
        for (const delivery of this.deliveries) {
            if (delivery.kind === "ocr") {
                this.releaseOcrDelivery(delivery);
            } else if (delivery.kind === "result") {
                this.pendingResultEntries -= 1;
            }
        }
        this.deliveries.length = 0;
        this.pendingSummary = undefined;
        this.frames.clear();
        this.candidates.clear();
        this.tracker.clear();
        this.maybeSettleFinish();
    }
}
