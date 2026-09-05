import { expect, test } from "vitest";
import { lootGlyphDistance } from "./loot-identity-core.mjs";

function glyph(rows) {
    const width = rows[0].length;
    const pixels = new Uint8ClampedArray(width * rows.length * 4).fill(255);
    for (const [y, row] of rows.entries()) {
        for (const [x, value] of [...row].entries()) {
            if (value === "#") pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
        }
    }
    return { width, height: rows.length, pixels };
}

test("distinguishes different shapes with identical column ink counts", () => {
    expect(lootGlyphDistance(glyph(["#.", ".#"]), glyph([".#", "#."]))).toBe(1);
});

test("allows a bounded vertical shift of the same shape", () => {
    const left = glyph(["....", ".##.", ".#..", "....", "...."]);
    const right = glyph(["....", "....", ".##.", ".#..", "...."]);
    expect(lootGlyphDistance(left, right)).toBeGreaterThan(0.1);
    expect(lootGlyphDistance(left, right, 1)).toBe(0);
    expect(lootGlyphDistance(right, left, 1)).toBe(0);
});

test("does not hide extra ink by shifting it outside the overlapping rows", () => {
    const left = glyph(["#..", "...", ".##", "..."]);
    const right = glyph(["...", ".##", "...", "..."]);
    expect(lootGlyphDistance(left, right, 1)).toBeGreaterThan(0.1);
});

test("treats missing glyphs as unknown rather than identical", () => {
    const blank = glyph(["...", "..."]);
    expect(lootGlyphDistance(blank, blank)).toBeNull();
    expect(lootGlyphDistance(blank, glyph([".#.", "..."]))).toBeNull();
});

test("rejects mismatched buffers, dimensions, and invalid tolerances", () => {
    const image = glyph([".#.", "###"]);
    expect(() => lootGlyphDistance(image, glyph([".#", "##"]))).toThrow("dimensions");
    expect(() => lootGlyphDistance(image, { ...image, pixels: new Uint8ClampedArray(1) })).toThrow("RGBA");
    for (const tolerance of [-1, 0.5, image.height]) {
        expect(() => lootGlyphDistance(image, image, tolerance)).toThrow("tolerance");
    }
});
