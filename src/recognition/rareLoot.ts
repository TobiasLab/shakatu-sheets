import type { LootDetectedRows, LootDetectionProfile, LootFingerprint, LootRoiFrame } from "./liveLoot";

const RARE_WIDTH = 400;
const RARE_HEIGHT = 100;
const TEXT_CENTER_Y = 57;
const SHELL_LEFT = 65;
const SHELL_RIGHT = 370;
const SHELL_TOP = 35;
const SHELL_BOTTOM = 80;
const SHELL_CONFIRM_RATIO = 0.65;
const CONFIRMATION_FRAMES = 4;
const MINIMUM_ACTIVE_FRAMES = 18;
const END_CONFIRMATION_FRAMES = 2;
const REAPPEARANCE_GAP_FRAMES = 4;

export const RARE_LOOT_PROFILE: LootDetectionProfile = {
    width: RARE_WIDTH,
    height: RARE_HEIGHT,
    maxRows: 1,
    bottomCenter: TEXT_CENTER_Y,
    spacing: 1,
    rowThreshold: 1,
};

export const RARE_LOOT_OCR_SELECTION = { frameCount: 3, delayFrames: 12 } as const;
export const RARE_LOOT_OCR_BOUNDS = { left: 40, right: 392, top: 20, bottom: 92 } as const;

const fingerprint: LootFingerprint = {
    full: new Uint8Array([1]),
    quantity: new Uint8Array([1]),
};

function emptyRows(): LootDetectedRows {
    return { count: 0, strength: 0, fingerprints: [], observations: [] };
}

function detectedRow(): LootDetectedRows {
    return {
        count: 1,
        strength: 1,
        fingerprint,
        fingerprints: [fingerprint],
        observations: [{ slot: 0, centerY: TEXT_CENTER_Y, score: 1, fingerprint }],
    };
}

function validateFrame(frame: LootRoiFrame) {
    if (frame.width !== RARE_WIDTH || frame.height !== RARE_HEIGHT) {
        throw new Error(`Rare loot ROI must be ${RARE_WIDTH}x${RARE_HEIGHT} pixels.`);
    }
    if (!(frame.pixels instanceof Uint8ClampedArray) || frame.pixels.length !== RARE_WIDTH * RARE_HEIGHT * 4) {
        throw new Error("Rare loot ROI pixels must be tightly packed RGBA data.");
    }
}

function shellRatio(frame: LootRoiFrame) {
    let warmPixels = 0;
    for (let y = SHELL_TOP; y < SHELL_BOTTOM; y += 1) {
        for (let x = SHELL_LEFT; x < SHELL_RIGHT; x += 1) {
            const offset = (y * frame.width + x) * 4;
            const red = frame.pixels[offset];
            const green = frame.pixels[offset + 1];
            const blue = frame.pixels[offset + 2];
            if (red >= 105 && green >= 65 && red - blue >= 55 && green - blue >= 20) warmPixels += 1;
        }
    }
    return warmPixels / ((SHELL_RIGHT - SHELL_LEFT) * (SHELL_BOTTOM - SHELL_TOP));
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

    pushFrame(frame: LootRoiFrame): LootDetectedRows {
        validateFrame(frame);
        const shellVisible = shellRatio(frame) >= SHELL_CONFIRM_RATIO;
        const baselineFrame = this.frameCount === 0;
        this.frameCount += 1;

        if (this.active) {
            this.activeFrames += 1;
            if (shellVisible && this.absentFrames >= REAPPEARANCE_GAP_FRAMES) {
                this.active = false;
                this.suppressed = false;
                this.activeFrames = 0;
                this.absentFrames = 0;
                this.candidateFrames = 1;
                this.candidateStartedAtBaseline = false;
                return emptyRows();
            }
            if (shellVisible) this.absentFrames = 0;
            else this.absentFrames += 1;
            if (this.absentFrames >= END_CONFIRMATION_FRAMES && this.activeFrames >= MINIMUM_ACTIVE_FRAMES) {
                this.active = false;
                this.suppressed = false;
                this.activeFrames = 0;
                this.absentFrames = 0;
                return emptyRows();
            }
            return this.suppressed ? emptyRows() : detectedRow();
        }

        if (!shellVisible) {
            this.candidateFrames = 0;
            this.candidateStartedAtBaseline = false;
            return emptyRows();
        }
        if (this.candidateFrames === 0) this.candidateStartedAtBaseline = baselineFrame;
        this.candidateFrames += 1;
        if (this.candidateFrames < CONFIRMATION_FRAMES) return emptyRows();

        this.active = true;
        this.suppressed = this.candidateStartedAtBaseline;
        this.activeFrames = 1;
        this.absentFrames = 0;
        this.candidateFrames = 0;
        this.candidateStartedAtBaseline = false;
        return this.suppressed ? emptyRows() : detectedRow();
    }
}
