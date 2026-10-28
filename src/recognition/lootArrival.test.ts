import { describe, expect, it } from "vitest";
import { LEGACY_LOOT_REGION_SIZES, LOOT_CROP_BOUNDS } from "./displayCapture";
import type { LootDetectedRows } from "./liveLoot";
import { findLiveLootProfile } from "./liveLootProfiles";
import {
    fadeWithoutArrival,
    fadingLootArrivals,
    type LootRowAppearance,
    lootRowAppearances,
    lootRowRefreshed,
    lootRowsFaded,
} from "./lootArrival";
import { LootRowTracker, rowBirthCount } from "./lootRowTracker";

const glyph = [0, 100, 200, 0, 150, 70, 0, 180];
const noise = [150, 0, 0, 180, 0, 0, 170, 0];
function appearance(visibility: number, text = true): LootRowAppearance {
    return { visibility, contrast: Uint16Array.from(text ? glyph : noise, (value) => (value * visibility) / 230) };
}
function rows(count: number, visibility: number[], absent: number[] = []): LootDetectedRows<number> {
    return {
        count,
        strength: count * 400,
        fingerprint: 1,
        fingerprints: Array(count).fill(1),
        appearances: visibility.map((value, index) => appearance(value, !absent.includes(index))),
        observations: visibility.slice(5 - count).map((_, index) => ({
            slot: 5 - count + index,
            centerY: 48 + (5 - count + index) * 39,
            score: 400,
            fingerprint: 1,
        })),
    };
}
const distance = (left = 0, right = 0) => Math.abs(left - right);

describe("fading loot arrivals", () => {
    it("counts a new identical row while the displaced oldest row fades out of the five-row list", () => {
        const before = rows(4, [30, 230, 230, 230, 230], [0]);
        const current = rows(5, [175, 230, 230, 230, 230]);
        const next = rows(4, [100, 158, 230, 230, 230]);
        expect(fadingLootArrivals(before, current, next)).toBe(1);
        expect(rowBirthCount(before, current, next, 196, distance)).toBe(1);
        expect(fadingLootArrivals(current, next, next)).toBe(0);
    });

    it("counts two simultaneous arrivals when a faint old row moves up two slots", () => {
        const before = rows(2, [30, 30, 30, 230, 230], [0, 1, 2]);
        const current = rows(4, [30, 150, 230, 230, 230], [0]);
        const next = rows(4, [30, 130, 230, 230, 230], [0]);
        expect(fadingLootArrivals(before, current, next)).toBe(2);
    });

    it("does not count an already-faint old row as an additional arrival", () => {
        const before = rows(1, [30, 30, 30, 131, 230], [0, 1, 2]);
        const current = rows(2, [30, 30, 119, 230, 230], [0, 1]);
        const next = rows(2, [30, 30, 60, 230, 230], [0, 1]);
        expect(fadingLootArrivals(before, current, next)).toBe(1);
    });

    it("counts two arrivals when an older faint row disappears during the shift", () => {
        const before = rows(1, [30, 30, 30, 100, 208], [0, 1, 2]);
        const current = rows(2, [30, 63, 133, 230, 230], [0, 1]);
        const next = rows(2, [30, 30, 60, 230, 230], [0, 1, 2]);
        expect(fadingLootArrivals(before, current, next)).toBe(2);
    });

    it("does not discard a still-bright different item to explain a larger shift", () => {
        const before = rows(2, [30, 30, 132, 230, 230], [0, 1]);
        const current = rows(3, [30, 77, 230, 230, 230], [0]);
        const next = rows(3, [30, 50, 230, 230, 230], [0, 1]);
        if (!before.appearances || !current.appearances || !next.appearances) throw new Error("Missing test rows");
        before.appearances[3] = appearance(230, false);
        current.appearances[2] = appearance(230, false);
        next.appearances[2] = appearance(230, false);
        expect(fadingLootArrivals(before, current, next)).toBe(0);
    });

    it("recognizes a repeated bottom row with a fading copy above it and stable lookahead", () => {
        const before = rows(1, [30, 30, 50, 120, 190], [0, 1]);
        const current = rows(1, [30, 30, 50, 105, 230], [0, 1]);
        const next = rows(1, [30, 30, 30, 60, 230], [0, 1, 2]);
        expect(fadingLootArrivals(before, current, next)).toBe(1);
        expect(fadingLootArrivals(before, current, undefined)).toBe(0);
        expect(fadingLootArrivals(before, current, rows(0, [30, 30, 30, 30, 30]))).toBe(0);
    });

    it("does not infer invisible replacements of five identical opaque rows", () => {
        const full = rows(5, [230, 230, 230, 230, 230]);
        expect(fadingLootArrivals(full, full, full)).toBe(0);
        const tracker = new LootRowTracker(196, distance);
        for (let index = 0; index < 40; index++) tracker.push(full);
        expect(tracker.finish().filter((track) => !track.baseline)).toHaveLength(0);
    });

    it("rejects global brightening, unrelated scenery, and transient bottom flashes", () => {
        const before = rows(1, [30, 30, 30, 120, 180], [0, 1, 2]);
        const flash = rows(1, [50, 50, 50, 160, 230], [0, 1, 2]);
        expect(fadingLootArrivals(before, flash, flash)).toBe(0);
        const unrelated = rows(1, [30, 30, 30, 100, 230], [0, 1, 2, 3]);
        expect(fadingLootArrivals(before, unrelated, unrelated)).toBe(0);
        const current = rows(1, [30, 30, 30, 100, 230], [0, 1, 2]);
        expect(fadingLootArrivals(before, current, before)).toBe(0);
    });

    it("preserves the newest track when identical top rows fade", () => {
        const before = rows(4, [30, 230, 230, 230, 230], [0]);
        const full = rows(5, [175, 230, 230, 230, 230]);
        const fading = rows(4, [100, 158, 230, 230, 230]);
        const faded = rows(3, [30, 70, 160, 230, 230]);
        expect(lootRowsFaded(full, fading)).toBe(true);
        expect(lootRowsFaded(fading, faded)).toBe(true);
        const tracker = new LootRowTracker(196, distance);
        for (const frame of [before, full, fading, faded, faded]) tracker.push(frame);
        const arrivals = tracker.finish().filter((track) => !track.baseline);
        expect(arrivals).toHaveLength(1);
        expect(arrivals[0].observations.map(({ centerY }) => centerY)).toEqual([204, 204, 204, 204]);
    });

    it("leaves custom and rare analyzers without appearance evidence unchanged", () => {
        const sample = rows(2, [30, 30, 30, 230, 230]);
        sample.appearances = undefined;
        expect(fadingLootArrivals(sample, sample, sample)).toBe(0);
        expect(lootRowsFaded(sample, sample)).toBe(false);
        expect(fadeWithoutArrival(sample, sample, rows(1, [30, 30, 30, 30, 230]), 1)).toBe(false);
    });
});

describe("identical rows across a short detector gap", () => {
    function arrivals(frames: LootDetectedRows<number>[]) {
        const tracker = new LootRowTracker(196, distance);
        for (const frame of frames) tracker.push(frame);
        return tracker.finish().filter((track) => !track.baseline).length;
    }
    const empty = { ...rows(0, [30, 30, 30, 30, 30]), appearances: undefined };
    const bright = rows(1, [30, 30, 30, 30, 228]);

    it("counts a fresh identical row after the previous one faded out", () => {
        const fading = rows(1, [30, 30, 30, 30, 169]);
        expect(lootRowRefreshed(fading, bright)).toBe(true);
        expect(arrivals([empty, bright, bright, fading, empty, bright, bright, empty, empty])).toBe(2);
    });

    it("keeps one identity when a bright row drops out for a frame", () => {
        expect(lootRowRefreshed(bright, bright)).toBe(false);
        expect(arrivals([empty, bright, bright, empty, bright, bright, empty, empty])).toBe(1);
    });
});

describe("fades without arrivals", () => {
    it("rejects a lone row that only dims", () => {
        const before = rows(1, [90, 100, 118, 141, 185]);
        const current = rows(1, [91, 95, 109, 124, 145]);
        expect(fadeWithoutArrival(before, current, current, 1)).toBe(true);
    });

    it("rejects an unchanged bright bottom row while the stack is about to shrink", () => {
        const before = rows(2, [99, 101, 94, 148, 228]);
        const current = rows(2, [100, 101, 94, 148, 228]);
        expect(fadeWithoutArrival(before, current, rows(1, [100, 101, 94, 80, 228]), 1)).toBe(true);
        expect(fadeWithoutArrival(before, current, current, 1)).toBe(false);
    });

    it("keeps a dimmer colored row that pushes a fading bottom row into a darker slot", () => {
        const before = rows(2, [30, 35, 90, 137, 200]);
        const current = rows(2, [36, 60, 100, 159, 213]);
        expect(fadeWithoutArrival(before, current, rows(1, [29, 47, 79, 131, 213]), 1)).toBe(false);
    });

    it("keeps a new row that pushes a dimming bottom row up while the stack grows", () => {
        const before = rows(2, [74, 100, 101, 168, 228]);
        const current = rows(2, [73, 100, 140, 183, 228]);
        expect(fadeWithoutArrival(before, current, rows(3, [73, 100, 140, 183, 228]), 1)).toBe(false);
    });

    it("keeps a brightened bottom row, a moved bottom row, and a growing stack", () => {
        const faded = rows(1, [83, 108, 89, 92, 140]);
        const refreshed = rows(1, [75, 88, 88, 115, 228]);
        expect(fadeWithoutArrival(faded, refreshed, rows(0, [75, 88, 88, 90, 100]), 1)).toBe(false);
        const full = rows(3, [74, 75, 154, 226, 228]);
        const shifted = rows(3, [76, 128, 225, 228, 228]);
        expect(fadeWithoutArrival(full, shifted, rows(2, [76, 90, 160, 228, 228]), 1)).toBe(false);
        expect(fadeWithoutArrival(rows(1, [90, 90, 90, 90, 228]), rows(2, [90, 90, 90, 150, 228]), undefined, 1)).toBe(
            false,
        );
    });
});

it.each([80, 100] as const)("extracts faint glyph contrast in bounded native geometry at %i%% scale", (uiScale) => {
    const artifact = findLiveLootProfile(3440, 1440, uiScale);
    if (!artifact) throw new Error("Missing test profile");
    const { profile } = artifact;
    const pixels = new Uint8ClampedArray(profile.width * profile.height * 4);
    const scale = profile.pixelScale ?? 1;
    for (let row = 0; row < 5; row++) {
        const center = profile.bottomCenter - (4 - row) * profile.spacing;
        const legacyWidth = LEGACY_LOOT_REGION_SIZES[uiScale].width;
        const offsetX = LOOT_CROP_BOUNDS[uiScale].normal.x;
        for (let x = Math.round(legacyWidth * 0.27) - offsetX; x < Math.round(legacyWidth * 0.55) - offsetX; x++) {
            if (Math.floor(x / scale) % 5 >= 3) continue;
            for (let y = center - Math.round(4 * scale); y <= center + Math.round(4 * scale); y++) {
                const offset = (y * profile.width + x) * 4;
                pixels.fill(row === 0 ? 110 : 230, offset, offset + 3);
            }
        }
    }
    const appearances = lootRowAppearances({ ...profile, pixels }, profile);
    expect(appearances.map(({ visibility }) => visibility)).toEqual([110, 230, 230, 230, 230]);
    expect(appearances[0].contrast.some((value) => value > 0)).toBe(true);
    expect(appearances.reduce((bytes, row) => bytes + row.contrast.byteLength, 0)).toBeLessThanOrEqual(1280);
});
