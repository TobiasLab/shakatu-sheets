import { describe, expect, it } from "vitest";
import { type LootDetectedRows, LootRowTracker, rowBirthCount } from "./liveLoot";
import { findLiveLootProfile } from "./liveLootProfiles";
import { fadingLootArrivals, type LootRowAppearance, lootRowAppearances, lootRowsFaded } from "./lootArrival";

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
        for (let x = Math.round(profile.width * 0.27); x < Math.round(profile.width * 0.55); x++) {
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
