import {
    isSupportedLootSource,
    LOOT_SEARCH_REGION_SIZE,
    type NormalizedRegion,
    pixelRegionToNormalized,
} from "./displayCapture";
import type { LootRoiFrame } from "./liveLoot";

const CROP_WIDTH = 362;
const CROP_HEIGHT = 311;
const ROW_CENTERS = [48, 87, 126, 165, 204] as const;
const MAX_HISTORY = 12;
const MAX_CANDIDATES = 4;
const LOCK_DISTANCE = 12;
const MIN_LOCAL_CROP_X = 99;
const SIGNAL_LEFT_FROM_CROP = -19;
const SIGNAL_RIGHT_FROM_CROP = 249;

export type LootSearchFrame = LootRoiFrame & {
    sourceWidth: number;
    sourceHeight: number;
    cropX: number;
    cropY: number;
};

export type NormalLootLocalization = {
    region: NormalizedRegion;
    replayFrames: LootRoiFrame[];
};

type Candidate = {
    x: number;
    y: number;
    quality: number;
    rowCount: number;
};

function luminance(pixels: Uint8ClampedArray, offset: number) {
    return (pixels[offset] * 77 + pixels[offset + 1] * 150 + pixels[offset + 2] * 29) >> 8;
}

function buildGlyphIntegral(frame: LootSearchFrame) {
    const { pixels, width, height } = frame;
    const stride = width + 1;
    const integral = new Uint32Array(stride * (height + 1));
    for (let y = 0; y < height; y += 1) {
        let rowTotal = 0;
        for (let x = 0; x < width; x += 1) {
            if (x >= 2 && x < width - 2 && y >= 8 && y < height - 8) {
                const offset = (y * width + x) * 4;
                const light = luminance(pixels, offset);
                const chroma =
                    Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) -
                    Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
                const horizontal = Math.min(luminance(pixels, offset - 8), luminance(pixels, offset + 8));
                const vertical = Math.min(luminance(pixels, offset - width * 8), luminance(pixels, offset + width * 8));
                if (light >= 115 && chroma <= 55 && light - Math.min(horizontal, vertical) >= 18) rowTotal += 1;
            }
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowTotal;
        }
    }
    return integral;
}

function rectangleSum(integral: Uint32Array, stride: number, left: number, top: number, right: number, bottom: number) {
    return (
        integral[bottom * stride + right] -
        integral[top * stride + right] -
        integral[bottom * stride + left] +
        integral[top * stride + left]
    );
}

function locateCandidate(frame: LootSearchFrame): Candidate | null {
    const integral = buildGlyphIntegral(frame);
    const stride = frame.width + 1;
    let best: Candidate | null = null;

    for (let cropY = 0; cropY <= frame.height - CROP_HEIGHT; cropY += 1) {
        for (let localCropX = MIN_LOCAL_CROP_X; localCropX + CROP_WIDTH <= frame.width; localCropX += 2) {
            const scores = ROW_CENTERS.map((center) =>
                rectangleSum(
                    integral,
                    stride,
                    localCropX + SIGNAL_LEFT_FROM_CROP,
                    cropY + center - 6,
                    localCropX + SIGNAL_RIGHT_FROM_CROP,
                    cropY + center + 7,
                ),
            );
            let candidateQuality = 0;
            let candidateRows = 0;
            let total = 0;
            let minimum = Number.POSITIVE_INFINITY;
            for (let rowCount = 1; rowCount <= ROW_CENTERS.length; rowCount += 1) {
                const score = scores[scores.length - rowCount];
                total += score;
                minimum = Math.min(minimum, score);
                const mean = total / rowCount;
                const quality = minimum * (1 + 0.12 * (rowCount - 1)) + mean * 0.05;
                if (quality > candidateQuality) {
                    candidateQuality = quality;
                    candidateRows = rowCount;
                }
            }
            if (best === null || candidateQuality > best.quality) {
                best = {
                    x: frame.cropX + localCropX,
                    y: frame.cropY + cropY,
                    quality: candidateQuality,
                    rowCount: candidateRows,
                };
            }
        }
    }

    return best && best.quality >= 350 && best.rowCount >= 2 ? best : null;
}

function lockedCandidates(candidates: readonly (Candidate | null)[]) {
    const qualifying = candidates.filter((candidate): candidate is Candidate => candidate !== null);
    let best: Candidate[] = [];
    for (let mask = 0; mask < 1 << qualifying.length; mask += 1) {
        const cluster = qualifying.filter((_, index) => (mask & (1 << index)) !== 0);
        if (cluster.length < 3 || cluster.length < best.length) continue;
        const clustered = cluster.every((left, index) =>
            cluster.slice(index + 1).every((right) => Math.hypot(left.x - right.x, left.y - right.y) <= LOCK_DISTANCE),
        );
        if (clustered && cluster.length > best.length) best = cluster;
    }
    return best.length >= 3 ? best : null;
}

function upperMedian(values: number[]) {
    values.sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)];
}

function cropFrame(frame: LootSearchFrame, x: number, y: number): LootRoiFrame | null {
    const localX = x - frame.cropX;
    const localY = y - frame.cropY;
    if (localX < 0 || localY < 0 || localX + CROP_WIDTH > frame.width || localY + CROP_HEIGHT > frame.height) {
        return null;
    }
    const pixels = new Uint8ClampedArray(CROP_WIDTH * CROP_HEIGHT * 4);
    const rowBytes = CROP_WIDTH * 4;
    for (let row = 0; row < CROP_HEIGHT; row += 1) {
        const sourceOffset = ((localY + row) * frame.width + localX) * 4;
        pixels.set(frame.pixels.subarray(sourceOffset, sourceOffset + rowBytes), row * rowBytes);
    }
    return { width: CROP_WIDTH, height: CROP_HEIGHT, pixels };
}

export function validateSearchFrame(frame: LootSearchFrame) {
    const metadata = [frame.width, frame.height, frame.sourceWidth, frame.sourceHeight, frame.cropX, frame.cropY];
    if (
        !(frame.pixels instanceof Uint8ClampedArray) ||
        !metadata.every(Number.isSafeInteger) ||
        frame.width !== LOOT_SEARCH_REGION_SIZE.width ||
        frame.height !== LOOT_SEARCH_REGION_SIZE.height ||
        !isSupportedLootSource(frame.sourceWidth, frame.sourceHeight) ||
        frame.cropX < 0 ||
        frame.cropY < 0 ||
        frame.cropX + frame.width > frame.sourceWidth ||
        frame.cropY + frame.height > frame.sourceHeight ||
        frame.pixels.length !== frame.width * frame.height * 4
    ) {
        throw new Error(
            "Loot localization requires a valid 800x600 RGBA search frame from a supported source (3440x1440, 2560x1440, or 1920x1080).",
        );
    }
}

export class NormalLootLocalizer {
    private readonly history: LootSearchFrame[] = [];
    private readonly candidates: Array<Candidate | null> = [];
    private incomingFrameCount = 0;

    get retainedFrameCount() {
        return this.history.length;
    }

    get evaluatedCandidateCount() {
        return this.candidates.length;
    }

    pushFrame(frame: LootSearchFrame): NormalLootLocalization | null {
        validateSearchFrame(frame);
        const previous = this.history[0];
        if (previous && (previous.sourceWidth !== frame.sourceWidth || previous.sourceHeight !== frame.sourceHeight)) {
            this.clear();
        }
        this.history.push(frame);
        if (this.history.length > MAX_HISTORY) this.history.shift();
        this.incomingFrameCount += 1;
        if (this.incomingFrameCount % 2 !== 0) return null;

        this.candidates.push(locateCandidate(frame));
        if (this.candidates.length > MAX_CANDIDATES) this.candidates.shift();
        const cluster = lockedCandidates(this.candidates);
        if (!cluster) return null;

        const x = upperMedian(cluster.map((candidate) => candidate.x));
        const y = upperMedian(cluster.map((candidate) => candidate.y));
        const replayFrames = this.history
            .map((retained) => cropFrame(retained, x, y))
            .filter((retained): retained is LootRoiFrame => retained !== null);
        const region = pixelRegionToNormalized(
            { x, y, width: CROP_WIDTH, height: CROP_HEIGHT },
            frame.sourceWidth,
            frame.sourceHeight,
        );
        this.clear();
        return { region, replayFrames };
    }

    clear() {
        this.history.length = 0;
        this.candidates.length = 0;
        this.incomingFrameCount = 0;
    }
}
