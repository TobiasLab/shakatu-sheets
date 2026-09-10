import { describe, expect, it } from "vitest";
import { LOOT_CROP_BOUNDS, type LootUiScale, normalizedRegionToPixels, positionLootRegion } from "./displayCapture";
import { analyzeLootRoiFrame, type LootRoiFrame } from "./liveLoot";
import { preprocessLootOcrFrame } from "./liveLootOcr";
import { findLiveLootProfile, findRareLootGeometry } from "./liveLootProfiles";
import { RareLootFrameAnalyzer } from "./rareLoot";

function blank(width: number, height: number): LootRoiFrame {
    return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}
function crop(frame: LootRoiFrame, box: { x: number; y: number; width: number; height: number }) {
    const result = blank(box.width, box.height);
    for (let y = 0; y < box.height; y++) {
        const offset = ((y + box.y) * frame.width + box.x) * 4;
        result.pixels.set(frame.pixels.subarray(offset, offset + box.width * 4), y * box.width * 4);
    }
    return result;
}
function paint(frame: LootRoiFrame, left: number, top: number, right: number, bottom: number, color: number[]) {
    for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) frame.pixels.set(color, (y * frame.width + x) * 4);
}

for (const scale of [80, 100] as LootUiScale[]) {
    describe(`compact loot pixels at ${scale}%`, () => {
        it("preserves normal row scores, quantity fingerprints, and OCR pixels", () => {
            const original = findLiveLootProfile(3440, 1440, scale, true)?.profile;
            const compact = findLiveLootProfile(3440, 1440, scale)?.profile;
            if (!original || !compact) throw new Error("Missing normal profiles");
            const bounds = LOOT_CROP_BOUNDS[scale].normal;
            const input = blank(original.width, original.height);
            const factor = scale / 80;
            for (let row = 0; row < 5; row++) {
                const center = original.bottomCenter - row * original.spacing;
                for (let x = Math.round(original.width * 0.22); x < Math.round(original.width * 0.96) - 3; x += 5) {
                    paint(input, x, center - 5, x + 2, center + 6, [225, 225, 225, 255]);
                }
            }
            const smaller = crop(input, bounds);
            const before = analyzeLootRoiFrame(input, original);
            const after = analyzeLootRoiFrame(smaller, compact);
            expect(before.count).toBe(5);
            expect(after).toEqual({
                ...before,
                observations: before.observations.map((row) => ({ ...row, centerY: row.centerY - bounds.y })),
            });
            const padding = Math.round(12 * factor);
            for (let row = 0; row < 5; row++) {
                const center = original.bottomCenter - row * original.spacing;
                const box = {
                    left: Math.round(original.width * 0.25),
                    right: Math.round(original.width * 0.96),
                    top: center - padding,
                    bottom: center + padding,
                };
                const translated = {
                    left: box.left - bounds.x,
                    right: box.right - bounds.x,
                    top: box.top - bounds.y,
                    bottom: box.bottom - bounds.y,
                };
                for (const font of ["korean", "strong-sword"] as const) {
                    expect(
                        preprocessLootOcrFrame(smaller, center - bounds.y, 150, translated, "white", 2, font),
                    ).toEqual(preprocessLootOcrFrame(input, center, 150, box, "white", 2, font));
                }
            }
        });
        it("preserves rare banner detection and the entire gold OCR line", () => {
            const original = findRareLootGeometry(3440, 1440, scale, true);
            const compact = findRareLootGeometry(3440, 1440, scale);
            if (!original || !compact) throw new Error("Missing rare geometry");
            const input = blank(original.width, original.height);
            for (const box of [original.shell, original.border])
                paint(input, box.left, box.top, box.right, box.bottom, [180, 125, 35, 255]);
            const smaller = crop(input, LOOT_CROP_BOUNDS[scale].rare);
            const before = new RareLootFrameAnalyzer(original);
            const after = new RareLootFrameAnalyzer(compact);
            for (let i = 0; i < 6; i++) {
                const a = before.pushFrame(input);
                const b = after.pushFrame(smaller);
                expect(b.count).toBe(a.count);
            }
            expect(preprocessLootOcrFrame(smaller, compact.textCenterY, 150, compact.ocrBounds, "gold")).toEqual(
                preprocessLootOcrFrame(input, original.textCenterY, 150, original.ocrBounds, "gold"),
            );
        });
        it("lets both actual crops touch every source edge", () => {
            for (const kind of ["normal", "rare"] as const)
                for (const [x, y] of [
                    [0, 0],
                    [0, 1],
                    [1, 0],
                    [1, 1],
                ]) {
                    const region = normalizedRegionToPixels(
                        positionLootRegion(x, y, 3440, 1440, scale, kind),
                        3440,
                        1440,
                    );
                    expect(x === 0 ? region.x : region.x + region.width).toBe(x * 3440);
                    expect(y === 0 ? region.y : region.y + region.height).toBe(y * 1440);
                }
        });
    });
}
