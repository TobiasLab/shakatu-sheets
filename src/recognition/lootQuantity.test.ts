import { expect, it } from "vitest";
import { lootRowIdentityDistance } from "./liveLoot";
import { type LootQuantityGlyphs, locateLootQuantity, lootQuantityDistance } from "./lootQuantity";

function glyph(rows: string[], left = 10, top = 0): LootQuantityGlyphs {
    return {
        bounds: { left, right: left + rows[0].length, top, bottom: top + rows.length },
        pixels: Uint8Array.from(rows.join(""), (value) => (value === "#" ? 1 : 0)),
    };
}

it("aligns upward row movement by one native pixel without hiding extra strokes", () => {
    const left = glyph(["....", ".##.", ".#..", "....", "...."], 10, 40);
    const right = glyph(["....", "....", ".##.", ".#..", "...."]);
    expect(lootQuantityDistance(left, right)).toBe(0);
    expect(lootQuantityDistance(left, glyph(["#...", "....", ".##.", ".#..", "...."]))).toBeGreaterThan(0.1);
    expect(lootQuantityDistance(left, glyph(["....", "....", ".##.", ".#..", "...."], 14))).toBe(1);
});

it("supplements name identity while treating fading text as uncertain", () => {
    const left = {
        full: new Uint8Array([10, 10, 10, 10]),
        quantity: new Uint8Array([10]),
        digits: glyph(["##..", "....", "...."]),
    };
    const right = {
        ...left,
        full: new Uint8Array([10, 10, 10, 4]),
        quantity: new Uint8Array([4]),
        digits: glyph(["..##", "....", "...."]),
    };
    expect(lootRowIdentityDistance(left, right)).toBe(1);
    expect(
        lootRowIdentityDistance(left, { ...right, full: new Uint8Array([5, 5, 5, 5]), quantity: new Uint8Array([5]) }),
    ).toBe(0);
});

it.each([1, 1.25])("locates a multidigit suffix independently of the item name at scale %s", (scale) => {
    const width = Math.round(362 * scale);
    const height = 80;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const projection = new Uint8Array(Math.round(width * 0.69));
    const origin = Math.round(width * 0.27);
    // Name, marker, then two digits separated by a narrower internal gap.
    const spans = [
        [5, 35],
        [41, 47],
        [53, 58],
        [61, 66],
    ];
    for (const [left, right] of spans) {
        for (let x = Math.round(left * scale); x < Math.round(right * scale); x++) {
            projection[x] = 6;
            for (let y = 36; y < 43; y++)
                pixels.fill(255, (y * width + origin + x) * 4, (y * width + origin + x + 1) * 4);
        }
    }
    const found = locateLootQuantity({ width, height, pixels }, 40, projection, scale);
    expect(found?.bounds.left).toBe(origin + Math.round(53 * scale) - 1);
    expect(found?.bounds.right).toBe(origin + Math.round(66 * scale) + 1);
    expect(
        locateLootQuantity({ width, height, pixels: new Uint8ClampedArray(pixels.length) }, 40, projection, scale),
    ).toBeUndefined();
    expect(
        locateLootQuantity({ width, height, pixels }, 40, projection.subarray(0, Math.round(65 * scale)), scale),
    ).toBeUndefined();
});
