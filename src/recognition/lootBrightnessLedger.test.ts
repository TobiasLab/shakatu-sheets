import { describe, expect, it } from "vitest";
import { normalLootColumn } from "./displayCapture";
import type { LootDetectionProfile, LootRoiFrame } from "./liveLoot";
import { findLiveLootProfile } from "./liveLootProfiles";
import { LOOT_TEXT_LUMINANCE, LootBrightnessLedger, lootRowOpacities } from "./lootBrightnessLedger";

function profileAt(uiScalePercent: 80 | 100) {
    const artifact = findLiveLootProfile(3440, 1440, uiScalePercent);
    if (!artifact) throw new Error("Missing test profile");
    return artifact.profile;
}
const profile = profileAt(80);
const FULL = LOOT_TEXT_LUMINANCE.korean;

/** Paints comb-shaped "text" into the bottom `rows` slots over uniform scenery. */
function frameWithRows(
    scenery: number,
    rows: number,
    text: [number, number, number],
    { width, height, maxRows, bottomCenter, spacing }: LootDetectionProfile = profile,
): LootRoiFrame {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(scenery);
    for (let slot = maxRows - rows; slot < maxRows; slot++) {
        const center = bottomCenter - (maxRows - slot - 1) * spacing;
        for (let x = normalLootColumn(width, 0.27); x < normalLootColumn(width, 0.55); x++) {
            if (x % 5 >= 3) continue;
            for (let y = center - 4; y <= center + 4; y++) pixels.set(text, (y * width + x) * 4);
        }
    }
    return { width, height, pixels };
}

describe("loot row opacity", () => {
    it.each([20, 150])("reads a fully shown row as 1 over scenery at luminance %i", (scenery) => {
        const opacities = lootRowOpacities(frameWithRows(scenery, 2, [FULL, FULL, FULL]), profile, FULL);
        expect(opacities.slice(3)).toEqual([1, 1]);
        expect(opacities.slice(0, 3)).toEqual([0, 0, 0]);
    });

    it("reads rows at 100% UI scale", () => {
        const scaled = profileAt(100);
        const opacities = lootRowOpacities(frameWithRows(20, 2, [FULL, FULL, FULL], scaled), scaled, FULL);
        expect(opacities).toEqual([0, 0, 0, 1, 1]);
    });

    it.each([20, 150])("reads a half-faded row as one half over scenery at luminance %i", (scenery) => {
        const faded = Math.round((FULL + scenery) / 2);
        const opacities = lootRowOpacities(frameWithRows(scenery, 1, [faded, faded, faded]), profile, FULL);
        expect(opacities[4]).toBeCloseTo(0.5, 2);
    });

    it("ignores bright saturated scenery that only looks like text by contrast", () => {
        expect(lootRowOpacities(frameWithRows(20, 1, [240, 200, 60]), profile, FULL)[4]).toBe(0);
    });

    it("reports a slot it cannot measure against scenery nearly as bright as the text", () => {
        expect(lootRowOpacities(frameWithRows(200, 1, [FULL, FULL, FULL]), profile, FULL)).toEqual(
            Array.from({ length: profile.maxRows }, () => Number.NaN),
        );
    });
});

const unmeasurable = Array.from({ length: 5 }, () => Number.NaN);

/**
 * Feeds opacity frames (top slot first) the way the coordinator does: the tracker's count for a frame arrives after
 * the next frame was pushed. The last frame is then held so every difference has time to settle.
 */
function audit(frames: number[][], counted: Record<number, number> = {}, detectedRows = 5) {
    const ledger = new LootBrightnessLedger();
    const held = Array.from({ length: 20 }, () => frames[frames.length - 1]);
    [...frames, ...held].forEach((opacities, frame) => {
        ledger.push(frame, opacities, detectedRows);
        for (let count = counted[frame - 1] ?? 0; count > 0; count--) ledger.counted(frame - 1);
    });
    return ledger.takeEvents();
}

// Recorded: an identical drop arrives in frame 3, just as the previous bottom row starts to fade.
const replacedAtExpiry = [
    [0.25, 0.28, 0.99, 1, 1],
    [0.26, 0.29, 0.69, 1, 1],
    [0.25, 0.28, 0.47, 0.8, 1],
    [0.25, 0.41, 0.69, 1, 1],
    [0.21, 0.28, 0.47, 0.81, 0.99],
    [0.23, 0.29, 0.34, 0.63, 0.99],
    [0.19, 0.28, 0.26, 0.4, 1],
];

// One row, then a second in frame 1 and a third in frame 4.
const twoArrivals = [
    [0.2, 0.2, 0.2, 0.2, 1],
    [0.2, 0.2, 0.2, 1, 1],
    [0.2, 0.2, 0.2, 1, 1],
    [0.2, 0.2, 0.2, 1, 1],
    [0.2, 0.2, 1, 1, 1],
];

describe("loot brightness ledger", () => {
    it("reports an identical drop that replaced a row just as it started to fade", () => {
        expect(audit(replacedAtExpiry)).toEqual([{ kind: "missed", frame: 3, count: 1 }]);
    });

    it("stays silent when the tracker counted the same drop", () => {
        expect(audit(replacedAtExpiry, { 3: 1 })).toEqual([]);
    });

    it("tolerates the tracker attributing a drop to a neighbouring frame", () => {
        expect(audit(replacedAtExpiry, { 5: 1 })).toEqual([]);
    });

    it("dates each missed drop by its own frame", () => {
        expect(audit(twoArrivals)).toEqual([
            { kind: "missed", frame: 1, count: 1 },
            { kind: "missed", frame: 4, count: 1 },
        ]);
    });

    it("keeps a missed drop's frame when the tracker dates a later drop a frame late", () => {
        expect(audit(twoArrivals, { 5: 1 })).toEqual([{ kind: "missed", frame: 1, count: 1 }]);
    });

    it("reports drops of one frame as one event", () => {
        const frames = [
            [0.2, 0.2, 0.2, 0.2, 1],
            [0.2, 0.2, 1, 1, 1],
        ];
        expect(audit(frames)).toEqual([{ kind: "missed", frame: 1, count: 2 }]);
    });

    it("still matches a count the tracker reports several frames late", () => {
        const ledger = new LootBrightnessLedger();
        twoArrivals.slice(0, 4).forEach((opacities, frame) => {
            ledger.push(frame, opacities, 5);
        });
        ledger.counted(1);
        for (let frame = 4; frame < 24; frame++) ledger.push(frame, twoArrivals[3], 5);
        expect(ledger.takeEvents()).toEqual([]);
    });

    it("counts a drop that arrives while the oldest row starts fading", () => {
        // Recorded: three fully shown rows stay three, and the row pushed up is suddenly fading.
        const frames = [
            [0.29, 0.22, 0.98, 1, 1],
            [0.29, 0.22, 0.98, 1, 1],
            [0.32, 0.69, 1, 1, 1],
            [0.24, 0.46, 0.8, 1, 1],
        ];
        expect(audit(frames, { 2: 1 })).toEqual([]);
        expect(audit(frames)).toEqual([{ kind: "missed", frame: 2, count: 1 }]);
    });

    it("reports a drop the tracker counted while the rows only faded", () => {
        // Recorded: the top row fades out and nothing arrives, but the tracker counted a drop in frame 3.
        const frames = [
            [0.29, 0.21, 0.89, 1, 1],
            [0.28, 0.21, 0.71, 1, 1],
            [0.28, 0.2, 0.49, 1, 1],
            [0.28, 0.2, 0.44, 1, 1],
            [0.26, 0.21, 0.31, 1, 1],
        ];
        expect(audit(frames, { 3: 1 })).toEqual([{ kind: "phantom", frame: 3, count: 1 }]);
        expect(audit(frames)).toEqual([]);
    });

    it("does not count scenery above a fading row as another drop", () => {
        const frames = [
            [0.2, 0.2, 0.2, 1, 1],
            [0.2, 0.2, 0.2, 0.88, 1],
            [0.2, 0.52, 0.62, 1, 1],
        ];
        expect(audit(frames, { 2: 1 })).toEqual([]);
    });

    it("does not take dim scenery above the rows for a row that started fading", () => {
        const frames = [
            [0.2, 0.2, 0.2, 0.2, 1],
            [0.2, 0.2, 0.2, 0.55, 1],
            [0.2, 0.2, 0.2, 0.2, 1],
        ];
        expect(audit(frames)).toEqual([]);
    });

    it("counts only rows the detector found as fully shown", () => {
        const frames = [
            [0.2, 0.2, 0.2, 0.2, 0.2],
            [0.2, 0.2, 0.2, 0.2, 1],
        ];
        expect(audit(frames, {}, 0)).toEqual([]);
        expect(audit(frames, {}, 1)).toEqual([{ kind: "missed", frame: 1, count: 1 }]);
    });

    it("trusts the tracker while every slot holds a fully shown row", () => {
        const frames = [
            [0.2, 1, 1, 1, 1],
            [1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1],
        ];
        expect(audit(frames, { 1: 1, 2: 1 })).toEqual([]);
    });

    it("counts drops that arrived while the rows could not be measured", () => {
        const frames = [[0.2, 0.2, 0.2, 0.2, 1], unmeasurable, unmeasurable, [0.2, 0.2, 0.2, 1, 1]];
        expect(audit(frames)).toEqual([{ kind: "missed", frame: 3, count: 1 }]);
        expect(audit(frames, { 1: 1 })).toEqual([]);
    });

    it("trusts the tracker for drops it counted before the rows could first be measured", () => {
        const frames = [unmeasurable, unmeasurable, [0.2, 0.2, 0.2, 1, 1]];
        expect(audit(frames, { 0: 1, 1: 1 })).toEqual([]);
    });

    it("trusts the tracker for drops that came and went while the rows could not be measured", () => {
        const gap = Array.from({ length: 30 }, () => unmeasurable);
        const frames = [[0.2, 0.2, 0.2, 0.2, 1], ...gap, [0.2, 0.2, 0.2, 0.2, 1]];
        expect(audit(frames, { 3: 1, 4: 1 })).toEqual([]);
    });

    it("matches a drop counted early in a long stretch that could not be measured", () => {
        const gap = Array.from({ length: 30 }, () => unmeasurable);
        const frames = [[0.2, 0.2, 0.2, 0.2, 1], ...gap, [0.2, 0.2, 0.2, 1, 1]];
        expect(audit(frames, { 2: 1 })).toEqual([]);
        expect(audit(frames)).toEqual([{ kind: "missed", frame: 31, count: 1 }]);
    });
});
