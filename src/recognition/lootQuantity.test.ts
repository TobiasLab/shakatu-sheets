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
    expect(found?.itemBounds).toEqual({
        left: origin + Math.round(5 * scale) - 1,
        right: origin + Math.round(41 * scale) - 1,
        top: 40 - Math.round(8 * scale),
        bottom: 40 + Math.round(8 * scale),
    });
    expect(found?.bounds.right).toBe(origin + Math.round(66 * scale) + 1);
    const cropX = scale === 1 ? 78 : 97;
    const cropWidth = scale === 1 ? 272 : 341;
    const croppedPixels = new Uint8ClampedArray(cropWidth * height * 4);
    for (let y = 0; y < height; y++) {
        const start = (y * width + cropX) * 4;
        croppedPixels.set(pixels.subarray(start, start + cropWidth * 4), y * cropWidth * 4);
    }
    const compact = locateLootQuantity({ width: cropWidth, height, pixels: croppedPixels }, 40, projection, scale);
    expect(compact?.pixels).toEqual(found?.pixels);
    if (!found?.itemBounds) throw Error("Expected item bounds");
    expect(compact?.itemBounds).toEqual({
        ...found?.itemBounds,
        left: found.itemBounds.left - cropX,
        right: found.itemBounds.right - cropX,
    });
    expect(compact?.bounds).toEqual({
        ...found?.bounds,
        left: origin + Math.round(53 * scale) - 1 - cropX,
        right: origin + Math.round(66 * scale) + 1 - cropX,
    });
    expect(
        locateLootQuantity({ width, height, pixels: new Uint8ClampedArray(pixels.length) }, 40, projection, scale),
    ).toBeUndefined();
    expect(
        locateLootQuantity({ width, height, pixels }, 40, projection.subarray(0, Math.round(65 * scale)), scale),
    ).toBeUndefined();
});

it.each([1, 1.25])(
    "separates Strong Sword's narrower marker gaps without changing Korean extraction at %s",
    (scale) => {
        const width = Math.round(362 * scale);
        const height = 80;
        const origin = Math.round(width * 0.27);
        const pixels = new Uint8ClampedArray(width * height * 4);
        const projection = new Uint8Array(Math.round(width * 0.69));
        for (const [left, right] of [
            [5, 35],
            [39, 45],
            [49, 54],
            [56, 61],
        ]) {
            for (let x = Math.round(left * scale); x < Math.round(right * scale); x += 1) {
                projection[x] = 6;
                for (let y = 36; y < 43; y += 1)
                    pixels.fill(255, (y * width + origin + x) * 4, (y * width + origin + x + 1) * 4);
            }
        }
        const frame = { width, height, pixels };
        expect(locateLootQuantity(frame, 40, projection, scale)).toBeUndefined();
        const found = locateLootQuantity(frame, 40, projection, scale, "strong-sword");
        expect(found?.bounds.left).toBe(origin + Math.round(49 * scale) - 1);
        expect(found?.bounds.right).toBe(origin + Math.round(61 * scale) + 1);
        expect(
            locateLootQuantity(frame, 40, projection.subarray(0, Math.round(60 * scale)), scale, "strong-sword"),
        ).toBeUndefined();
        expect(locateLootQuantity(frame, 40, projection, scale, "korean")).toBeUndefined();
    },
);

it.each([1, 1.25])("separates Strong Sword x4 without splitting x16 or x180 at scale %s", (scale) => {
    const width = Math.round(362 * scale);
    const height = 80;
    const origin = Math.round(width * 0.27);
    for (const suffix of [
        [[50, 56]],
        [
            [53, 55],
            [58, 64],
        ],
        [
            [53, 55],
            [58, 64],
            [66, 72],
        ],
    ]) {
        const projection = new Uint8Array(Math.round(width * 0.69));
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (const [left, right] of [[5, 35], [40, 47], ...suffix]) {
            for (let x = Math.round(left * scale); x < Math.round(right * scale); x++) {
                projection[x] = 6;
                for (let y = 36; y < 43; y++)
                    pixels.fill(255, (y * width + origin + x) * 4, (y * width + origin + x + 1) * 4);
            }
        }
        const found = locateLootQuantity({ width, height, pixels }, 40, projection, scale, "strong-sword");
        expect(found?.bounds.left).toBe(origin + Math.round(suffix[0][0] * scale) - 1);
        expect(found?.bounds.right).toBe(origin + Math.round(suffix[suffix.length - 1][1] * scale) + 1);
    }
});
