import {
    isSupportedLootSource,
    LOOT_SEARCH_REGION_SIZE,
    type LootUiScale,
    lootRegionSize,
    type NormalizedRegion,
    pixelRegionToNormalized,
} from "./displayCapture";
import type { LootRoiFrame } from "./liveLoot";
import type { LootSampleFps } from "./lootCaptureTiming";

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

function buildGlyphIntegral(frame: LootSearchFrame, scale: number) {
    const edge = Math.round(2 * scale);
    const margin = Math.round(8 * scale);
    const step = edge * 4;
    const { pixels, width, height } = frame;
    const stride = width + 1;
    const integral = new Uint32Array(stride * (height + 1));
    for (let y = 0; y < height; y += 1) {
        let rowTotal = 0;
        for (let x = 0; x < width; x += 1) {
            if (x >= edge && x < width - edge && y >= margin && y < height - margin) {
                const offset = (y * width + x) * 4;
                const light = luminance(pixels, offset);
                const chroma =
                    Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) -
                    Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
                const horizontal = Math.min(luminance(pixels, offset - step), luminance(pixels, offset + step));
                const vertical = Math.min(
                    luminance(pixels, offset - width * step),
                    luminance(pixels, offset + width * step),
                );
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

function locateCandidate(frame: LootSearchFrame, uiScalePercent: LootUiScale): Candidate | null {
    const scale = uiScalePercent / 80;
    const { width: cropWidth, height: cropHeight } = lootRegionSize(uiScalePercent);
    const bottom = Math.round(204 * scale);
    const spacing = Math.round(39 * scale);
    const centers = Array.from({ length: 5 }, (_, index) => bottom - (4 - index) * spacing);
    const halfBand = Math.round(6 * scale);
    const signalLeft = Math.round(SIGNAL_LEFT_FROM_CROP * scale);
    const signalRight = Math.round(SIGNAL_RIGHT_FROM_CROP * scale);
    const integral = buildGlyphIntegral(frame, scale);
    const stride = frame.width + 1;
    let best: Candidate | null = null;

    for (let cropY = 0; cropY <= frame.height - cropHeight; cropY += 1) {
        for (
            let localCropX = Math.round(MIN_LOCAL_CROP_X * scale);
            localCropX + cropWidth <= frame.width;
            localCropX += 2
        ) {
            const scores = centers.map((center) =>
                rectangleSum(
                    integral,
                    stride,
                    localCropX + signalLeft,
                    cropY + center - halfBand,
                    localCropX + signalRight,
                    cropY + center + halfBand + 1,
                ),
            );
            let candidateQuality = 0;
            let candidateRows = 0;
            let total = 0;
            let minimum = Number.POSITIVE_INFINITY;
            for (let rowCount = 1; rowCount <= centers.length; rowCount += 1) {
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

    return best && best.quality >= 350 * scale * scale && best.rowCount >= 2 ? best : null;
}

function lockedCandidates(candidates: readonly (Candidate | null)[], scale: number) {
    const qualifying = candidates.filter((candidate): candidate is Candidate => candidate !== null);
    let best: Candidate[] = [];
    for (let mask = 0; mask < 1 << qualifying.length; mask += 1) {
        const cluster = qualifying.filter((_, index) => (mask & (1 << index)) !== 0);
        if (cluster.length < 3 || cluster.length < best.length) continue;
        const clustered = cluster.every((left, index) =>
            cluster
                .slice(index + 1)
                .every((right) => Math.hypot(left.x - right.x, left.y - right.y) <= LOCK_DISTANCE * scale),
        );
        if (clustered && cluster.length > best.length) best = cluster;
    }
    return best.length >= 3 ? best : null;
}

function upperMedian(values: number[]) {
    values.sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)];
}

function cropFrame(frame: LootSearchFrame, x: number, y: number, uiScalePercent: LootUiScale): LootRoiFrame | null {
    const { width: cropWidth, height: cropHeight } = lootRegionSize(uiScalePercent);
    const localX = x - frame.cropX;
    const localY = y - frame.cropY;
    if (localX < 0 || localY < 0 || localX + cropWidth > frame.width || localY + cropHeight > frame.height) {
        return null;
    }
    const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    const rowBytes = cropWidth * 4;
    for (let row = 0; row < cropHeight; row += 1) {
        const sourceOffset = ((localY + row) * frame.width + localX) * 4;
        pixels.set(frame.pixels.subarray(sourceOffset, sourceOffset + rowBytes), row * rowBytes);
    }
    return { width: cropWidth, height: cropHeight, pixels };
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

    constructor(
        private readonly uiScalePercent: LootUiScale = 80,
        private readonly sampleFps: LootSampleFps = 8,
    ) {}

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
        if (this.history.length > MAX_HISTORY * (this.sampleFps / 8)) this.history.shift();
        this.incomingFrameCount += 1;
        if (this.incomingFrameCount % (2 * (this.sampleFps / 8)) !== 0) return null;

        this.candidates.push(locateCandidate(frame, this.uiScalePercent));
        if (this.candidates.length > MAX_CANDIDATES) this.candidates.shift();
        const cluster = lockedCandidates(this.candidates, this.uiScalePercent / 80);
        if (!cluster) return null;

        const x = upperMedian(cluster.map((candidate) => candidate.x));
        const y = upperMedian(cluster.map((candidate) => candidate.y));
        const replayFrames = this.history
            .map((retained) => cropFrame(retained, x, y, this.uiScalePercent))
            .filter((retained): retained is LootRoiFrame => retained !== null);
        const { width: cropWidth, height: cropHeight } = lootRegionSize(this.uiScalePercent);
        const region = pixelRegionToNormalized(
            { x, y, width: cropWidth, height: cropHeight },
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
