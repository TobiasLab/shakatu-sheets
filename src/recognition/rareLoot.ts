import { LOOT_CROP_BOUNDS, type LootUiScale } from "./displayCapture";
import type { LootDetectedRows, LootDetectionProfile, LootFingerprint, LootOcrBounds, LootRoiFrame } from "./liveLoot";
import type { LootSampleFps } from "./lootCaptureTiming";
import { luminance } from "./lootPixels";

const SHELL_CONFIRM_RATIO = 0.65;
const CONFIRMATION_FRAMES = 4;
const MINIMUM_ACTIVE_FRAMES = 18;
const END_CONFIRMATION_FRAMES = 2;
const REAPPEARANCE_GAP_FRAMES = 4;

export type RareLootGeometry = {
    width: number;
    height: number;
    textCenterY: number;
    shell: LootOcrBounds;
    border: LootOcrBounds;
    borderOffset: number;
    borderMinPixels: number;
    ocrBounds: LootOcrBounds;
};

export function validateRareLootGeometry(geometry: RareLootGeometry): RareLootGeometry {
    const { width, height, textCenterY, borderOffset, borderMinPixels } = geometry;
    if (
        !(
            (width === 400 && height === 100) ||
            (width === 500 && height === 125) ||
            (width === 340 && height === 72) ||
            (width === 425 && height === 90)
        ) ||
        ![textCenterY, borderOffset, borderMinPixels].every(Number.isSafeInteger) ||
        textCenterY < 0 ||
        textCenterY >= height ||
        borderOffset <= 0 ||
        borderMinPixels <= 0
    ) {
        throw new Error("Invalid calibrated rare loot geometry.");
    }
    for (const box of [geometry.shell, geometry.border, geometry.ocrBounds]) {
        if (
            ![box.left, box.right, box.top, box.bottom].every(Number.isSafeInteger) ||
            box.left < 0 ||
            box.top < 0 ||
            box.left >= box.right ||
            box.top >= box.bottom ||
            box.right > width ||
            box.bottom > height
        ) {
            throw new Error("Rare loot geometry must stay inside its native crop.");
        }
    }
    if (
        geometry.border.top < borderOffset ||
        borderMinPixels > geometry.border.right - geometry.border.left ||
        textCenterY < geometry.ocrBounds.top ||
        textCenterY >= geometry.ocrBounds.bottom
    ) {
        throw new Error("Rare loot border or text geometry is invalid.");
    }
    return {
        ...geometry,
        shell: { ...geometry.shell },
        border: { ...geometry.border },
        ocrBounds: { ...geometry.ocrBounds },
    };
}

export const RARE_LOOT_GEOMETRY = validateRareLootGeometry({
    width: 400,
    height: 100,
    textCenterY: 57,
    shell: { left: 65, right: 370, top: 35, bottom: 80 },
    border: { left: 120, right: 320, top: 34, bottom: 38 },
    borderOffset: 3,
    borderMinPixels: 130,
    ocrBounds: { left: 112, right: 392, top: 49, bottom: 65 },
});

// Native 100% geometry derived from the 80% shell; gameplay validation remains pending.
export const RARE_LOOT_GEOMETRY_100 = validateRareLootGeometry({
    width: 500,
    height: 125,
    textCenterY: 71,
    shell: { left: 81, right: 463, top: 44, bottom: 100 },
    border: { left: 150, right: 400, top: 43, bottom: 48 },
    borderOffset: 4,
    borderMinPixels: 163,
    ocrBounds: { left: 140, right: 490, top: 61, bottom: 81 },
});

function compactRareGeometry(geometry: RareLootGeometry, scale: LootUiScale): RareLootGeometry {
    const crop = LOOT_CROP_BOUNDS[scale].rare;
    const translate = (box: LootOcrBounds) => ({
        left: box.left - crop.x,
        right: box.right - crop.x,
        top: box.top - crop.y,
        bottom: box.bottom - crop.y,
    });
    return validateRareLootGeometry({
        ...geometry,
        width: crop.width,
        height: crop.height,
        textCenterY: geometry.textCenterY - crop.y,
        shell: translate(geometry.shell),
        border: translate(geometry.border),
        ocrBounds: translate(geometry.ocrBounds),
    });
}
export const COMPACT_RARE_LOOT_GEOMETRY = compactRareGeometry(RARE_LOOT_GEOMETRY, 80);
export const COMPACT_RARE_LOOT_GEOMETRY_100 = compactRareGeometry(RARE_LOOT_GEOMETRY_100, 100);

export function rareLootDetectionProfile(geometry: RareLootGeometry): LootDetectionProfile {
    return {
        width: geometry.width,
        height: geometry.height,
        maxRows: 1,
        bottomCenter: geometry.textCenterY,
        spacing: 1,
        rowThreshold: 1,
    };
}
export const RARE_LOOT_PROFILE = rareLootDetectionProfile(RARE_LOOT_GEOMETRY);
export const RARE_LOOT_OCR_SELECTION = { frameCount: 3, delayFrames: 12 } as const;
export const RARE_LOOT_OCR_BOUNDS = RARE_LOOT_GEOMETRY.ocrBounds;

const fingerprint: LootFingerprint = {
    full: new Uint8Array([1]),
    quantity: new Uint8Array([1]),
};

function emptyRows(): LootDetectedRows {
    return { count: 0, strength: 0, fingerprints: [], observations: [] };
}

function detectedRow(geometry: RareLootGeometry, score = 1): LootDetectedRows {
    return {
        count: 1,
        strength: score,
        fingerprint,
        fingerprints: [fingerprint],
        observations: [{ slot: 0, centerY: geometry.textCenterY, score, fingerprint }],
    };
}

function validateFrame(frame: LootRoiFrame, geometry: RareLootGeometry) {
    const { width, height } = geometry;
    if (frame.width !== width || frame.height !== height) {
        throw new Error(`Rare loot ROI must be ${width}x${height} pixels.`);
    }
    if (!(frame.pixels instanceof Uint8ClampedArray) || frame.pixels.length !== width * height * 4) {
        throw new Error("Rare loot ROI pixels must be tightly packed RGBA data.");
    }
}

function shellRatio(frame: LootRoiFrame, geometry: RareLootGeometry) {
    const { left, right, top, bottom } = geometry.shell;
    let warmPixels = 0;
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const offset = (y * frame.width + x) * 4;
            const red = frame.pixels[offset];
            const green = frame.pixels[offset + 1];
            const blue = frame.pixels[offset + 2];
            if (red >= 105 && green >= 65 && red - blue >= 55 && green - blue >= 20) warmPixels += 1;
        }
    }
    return warmPixels / ((right - left) * (bottom - top));
}

function hasBannerBorder(frame: LootRoiFrame, geometry: RareLootGeometry) {
    const { left, right, top, bottom } = geometry.border;
    // The entrance has a long, level gold edge above the text. Gold scenery alone is insufficient.
    for (let y = top; y < bottom; y += 1) {
        let edgePixels = 0;
        for (let x = left; x < right; x += 1) {
            const offset = (y * frame.width + x) * 4;
            const above = offset - frame.width * 4 * geometry.borderOffset;
            if (luminance(frame.pixels, offset) - luminance(frame.pixels, above) >= 25) edgePixels += 1;
        }
        if (edgePixels >= geometry.borderMinPixels) return true;
    }
    return false;
}

/**
 * Provisional detector calibrated from one 3440x1440, 80%-UI rare banner. It confirms the distinctive gold shell,
 * keeps the event alive through its later readable phase, and suppresses a banner already active in the first frame.
 */
export class RareLootFrameAnalyzer {
    private frameCount = 0;
    private candidateFrames = 0;
    private candidateStartedAtBaseline = false;
    private active = false;
    private suppressed = false;
    private activeFrames = 0;
    private absentFrames = 0;
    private reappearanceFrames = 0;
    private replacementGapFrames = 0;

    private readonly geometry: RareLootGeometry;
    private readonly frameStep: number;
    constructor(geometry: RareLootGeometry = RARE_LOOT_GEOMETRY, sampleFps: LootSampleFps = 8) {
        this.frameStep = sampleFps / 8;
        this.geometry = validateRareLootGeometry(geometry);
    }

    pushFrame(frame: LootRoiFrame): LootDetectedRows {
        validateFrame(frame, this.geometry);
        const shellVisible =
            hasBannerBorder(frame, this.geometry) && shellRatio(frame, this.geometry) >= SHELL_CONFIRM_RATIO;
        const baselineFrame = this.frameCount === 0;
        this.frameCount += 1;

        if (this.replacementGapFrames > 0) {
            this.replacementGapFrames -= 1;
            if (this.replacementGapFrames > 0) return emptyRows();
            this.active = true;
            this.activeFrames = 1;
            this.absentFrames = shellVisible ? 0 : 1;
            return detectedRow(this.geometry);
        }

        if (this.active) {
            if (this.reappearanceFrames > 0) {
                if (shellVisible) this.reappearanceFrames += 1;
                else {
                    this.reappearanceFrames = 0;
                    this.absentFrames += 1;
                }
            } else if (shellVisible && this.absentFrames >= REAPPEARANCE_GAP_FRAMES * this.frameStep) {
                this.reappearanceFrames = 1;
            } else if (shellVisible) this.absentFrames = 0;
            else this.absentFrames += 1;

            if (this.reappearanceFrames >= CONFIRMATION_FRAMES * this.frameStep) {
                this.active = false;
                this.suppressed = false;
                this.activeFrames = 0;
                this.absentFrames = 0;
                this.reappearanceFrames = 0;
                this.replacementGapFrames = 2 * this.frameStep;
                return emptyRows();
            }
            if (
                this.reappearanceFrames === 0 &&
                this.absentFrames >= END_CONFIRMATION_FRAMES * this.frameStep &&
                this.activeFrames >= MINIMUM_ACTIVE_FRAMES * this.frameStep
            ) {
                this.active = false;
                this.suppressed = false;
                this.activeFrames = 0;
                this.absentFrames = 0;
                return emptyRows();
            }
            this.activeFrames += 1;
            return this.suppressed ? emptyRows() : detectedRow(this.geometry, this.reappearanceFrames > 0 ? 0 : 1);
        }

        if (!shellVisible) {
            this.candidateFrames = 0;
            this.candidateStartedAtBaseline = false;
            return emptyRows();
        }
        if (this.candidateFrames === 0) this.candidateStartedAtBaseline = baselineFrame;
        this.candidateFrames += 1;
        if (this.candidateFrames < CONFIRMATION_FRAMES * this.frameStep) return emptyRows();

        this.active = true;
        this.suppressed = this.candidateStartedAtBaseline;
        this.activeFrames = 1;
        this.absentFrames = 0;
        this.candidateFrames = 0;
        this.candidateStartedAtBaseline = false;
        return this.suppressed ? emptyRows() : detectedRow(this.geometry);
    }
}
