import { describe, expect, it } from "vitest";
import {
    defaultLootRegion,
    displayCaptureErrorMessage,
    isSupportedLootSource,
    LOOT_SEARCH_REGION_SIZE,
    lootAlignmentGuide,
    lootRegionSize,
    normalizedRegionToPixels,
    nudgeLootRegion,
    pixelRegionToNormalized,
    positionLootRegion,
    positionLootSearchRegion,
    searchRegionAroundLootRegion,
    stopDisplayCapture,
} from "./displayCapture";

describe("display capture lifecycle", () => {
    it("stops every track when capture ends", () => {
        const stopped: string[] = [];
        const stream = {
            getTracks: () => [{ stop: () => stopped.push("video") }, { stop: () => stopped.push("audio") }],
        } as unknown as MediaStream;

        stopDisplayCapture(stream);

        expect(stopped).toEqual(["video", "audio"]);
    });

    it("turns browser permission failures into useful messages", () => {
        expect(displayCaptureErrorMessage(new DOMException("denied", "NotAllowedError"))).toBe(
            "Screen sharing was cancelled or denied by the system.",
        );
        expect(displayCaptureErrorMessage(new Error("capture failed"))).toBe("capture failed");
    });
});

describe("loot capture region", () => {
    it("maps the benchmark default to its exact native crop", () => {
        expect(normalizedRegionToPixels(defaultLootRegion(3440, 1440, 80), 3440, 1440)).toEqual({
            x: 2433,
            y: 990,
            width: 362,
            height: 311,
        });
        expect(normalizedRegionToPixels(defaultLootRegion(3440, 1440, 80, "rare"), 3440, 1440)).toEqual({
            x: 2100,
            y: 820,
            width: 400,
            height: 100,
        });
    });

    it("provides exact normal and rare text-alignment guides at each UI scale", () => {
        expect(lootAlignmentGuide(80)).toEqual({
            x: 78,
            y: 36,
            width: 272,
            height: 180,
            rowCenters: [48, 87, 126, 165, 204],
        });
        expect(lootAlignmentGuide(100)).toEqual({
            x: 98,
            y: 45,
            width: 340,
            height: 225,
            rowCenters: [60, 109, 158, 206, 255],
        });
        expect(lootAlignmentGuide(80, "rare")).toEqual({
            x: 52,
            y: 20,
            width: 336,
            height: 72,
            rowCenters: [57],
        });
        expect(lootAlignmentGuide(100, "rare")).toEqual({
            x: 65,
            y: 25,
            width: 420,
            height: 90,
            rowCenters: [71],
        });
    });

    it("nudges either fixed area in source pixels and clamps at source bounds", () => {
        const normal = defaultLootRegion(3440, 1440, 80);
        expect(normalizedRegionToPixels(nudgeLootRegion(normal, -1, 1, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 2432,
            y: 991,
            width: 362,
            height: 311,
        });
        const rare = positionLootRegion(0, 0, 3440, 1440, 80, "rare");
        expect(normalizedRegionToPixels(nudgeLootRegion(rare, -10, -10, 3440, 1440, 80, "rare"), 3440, 1440)).toEqual({
            x: 0,
            y: 0,
            width: 400,
            height: 100,
        });
    });

    it("positions the fixed crop and clamps it to source bounds", () => {
        expect(normalizedRegionToPixels(positionLootRegion(0, 0, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 0,
            y: 0,
            width: 362,
            height: 311,
        });
        expect(normalizedRegionToPixels(positionLootRegion(1, 1, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 3078,
            y: 1129,
            width: 362,
            height: 311,
        });
    });

    it("creates exact 80% and 100% crops for every supported resolution", () => {
        for (const [width, height] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            for (const uiScalePercent of [80, 100] as const) {
                const pixels = normalizedRegionToPixels(
                    defaultLootRegion(width, height, uiScalePercent),
                    width,
                    height,
                );
                expect({ width: pixels.width, height: pixels.height }).toEqual(lootRegionSize(uiScalePercent));
                const rarePixels = normalizedRegionToPixels(
                    defaultLootRegion(width, height, uiScalePercent, "rare"),
                    width,
                    height,
                );
                expect({ width: rarePixels.width, height: rarePixels.height }).toEqual(
                    lootRegionSize(uiScalePercent, "rare"),
                );
            }
        }
    });

    it("rejects unsupported sources and malformed normalized bounds", () => {
        expect(isSupportedLootSource(3440, 1440)).toBe(true);
        expect(isSupportedLootSource(2560, 1440)).toBe(true);
        expect(isSupportedLootSource(1920, 1080)).toBe(true);
        expect(isSupportedLootSource(1280, 720)).toBe(false);
        expect(() => positionLootRegion(0.5, 0.5, 1280, 720, 80)).toThrow(/supported/);
        expect(() => normalizedRegionToPixels({ x: 0.9, y: 0, width: 0.2, height: 1 }, 3440, 1440)).toThrow(/invalid/);
    });
});

describe("automatic loot search region", () => {
    it("uses a fixed 800x600 calibrated search area containing the default ROI", () => {
        expect(LOOT_SEARCH_REGION_SIZE).toEqual({ width: 800, height: 600 });
        const exact = normalizedRegionToPixels(defaultLootRegion(3440, 1440, 80), 3440, 1440);
        const search = normalizedRegionToPixels(
            searchRegionAroundLootRegion(defaultLootRegion(3440, 1440, 80), 3440, 1440),
            3440,
            1440,
        );

        expect(search).toEqual({ x: 2214, y: 840, width: 800, height: 600 });
        expect(search.x).toBeLessThanOrEqual(exact.x);
        expect(search.y).toBeLessThanOrEqual(exact.y);
        expect(search.x + search.width).toBeGreaterThanOrEqual(exact.x + exact.width);
        expect(search.y + search.height).toBeGreaterThanOrEqual(exact.y + exact.height);
    });

    it("clamps search regions at every source edge", () => {
        expect(normalizedRegionToPixels(positionLootSearchRegion(0, 0, 3440, 1440), 3440, 1440)).toEqual({
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        });
        expect(normalizedRegionToPixels(positionLootSearchRegion(1, 1, 3440, 1440), 3440, 1440)).toEqual({
            x: 2640,
            y: 840,
            width: 800,
            height: 600,
        });
    });

    it("round-trips exact pixel regions deterministically", () => {
        for (const pixels of [
            { x: 0, y: 0, width: 800, height: 600 },
            { x: 2214, y: 840, width: 800, height: 600 },
            { x: 2433, y: 990, width: 362, height: 311 },
        ]) {
            expect(normalizedRegionToPixels(pixelRegionToNormalized(pixels, 3440, 1440), 3440, 1440)).toEqual(pixels);
        }
    });

    it("rejects unsupported search geometry and non-exact normal regions", () => {
        expect(() => positionLootSearchRegion(0.5, 0.5, 2561, 1440)).toThrow(/3440x1440/);
        expect(() =>
            searchRegionAroundLootRegion(
                pixelRegionToNormalized({ x: 10, y: 10, width: 453, height: 389 }, 3440, 1440),
                3440,
                1440,
            ),
        ).toThrow(/362x311/);
    });
});

it("keeps search areas inside both new source resolutions", () => {
    for (const [width, height] of [
        [2560, 1440],
        [1920, 1080],
    ]) {
        for (const [x, y] of [
            [0, 0],
            [1, 1],
        ]) {
            expect(normalizedRegionToPixels(positionLootSearchRegion(x, y, width, height), width, height)).toEqual({
                x: x === 0 ? 0 : width - 800,
                y: y === 0 ? 0 : height - 600,
                width: 800,
                height: 600,
            });
        }
        const exact = normalizedRegionToPixels(defaultLootRegion(width, height, 80), width, height);
        const search = normalizedRegionToPixels(
            searchRegionAroundLootRegion(defaultLootRegion(width, height, 80), width, height),
            width,
            height,
        );
        expect(search.x).toBeLessThanOrEqual(exact.x);
        expect(search.y).toBeLessThanOrEqual(exact.y);
        expect(search.x + 800).toBeGreaterThanOrEqual(exact.x + exact.width);
        expect(search.y + 600).toBeGreaterThanOrEqual(exact.y + exact.height);
    }
});
