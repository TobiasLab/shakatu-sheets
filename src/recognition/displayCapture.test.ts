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
    positionNormalLootFromLayout,
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
            x: 2511,
            y: 1026,
            width: 272,
            height: 180,
        });
        expect(normalizedRegionToPixels(defaultLootRegion(3440, 1440, 80, "rare"), 3440, 1440)).toEqual({
            x: 2152,
            y: 840,
            width: 340,
            height: 72,
        });
    });

    it("provides exact normal and rare text-alignment guides at each UI scale", () => {
        expect(lootAlignmentGuide(80)).toEqual({
            x: 0,
            y: 0,
            width: 272,
            height: 180,
            rowCenters: [12, 51, 90, 129, 168],
        });
        expect(lootAlignmentGuide(100)).toEqual({
            x: 0,
            y: 0,
            width: 341,
            height: 226,
            rowCenters: [15, 64, 113, 162, 211],
        });
        expect(lootAlignmentGuide(80, "rare")).toEqual({
            x: 0,
            y: 0,
            width: 340,
            height: 72,
            rowCenters: [37],
        });
        expect(lootAlignmentGuide(100, "rare")).toEqual({
            x: 0,
            y: 0,
            width: 425,
            height: 90,
            rowCenters: [46],
        });
    });

    it("nudges either fixed area in source pixels and clamps at source bounds", () => {
        const normal = defaultLootRegion(3440, 1440, 80);
        expect(normalizedRegionToPixels(nudgeLootRegion(normal, -1, 1, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 2510,
            y: 1027,
            width: 272,
            height: 180,
        });
        const rare = positionLootRegion(0, 0, 3440, 1440, 80, "rare");
        expect(normalizedRegionToPixels(nudgeLootRegion(rare, -10, -10, 3440, 1440, 80, "rare"), 3440, 1440)).toEqual({
            x: 0,
            y: 0,
            width: 340,
            height: 72,
        });
    });

    it("positions the fixed crop and clamps it to source bounds", () => {
        expect(normalizedRegionToPixels(positionLootRegion(0, 0, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 0,
            y: 0,
            width: 272,
            height: 180,
        });
        expect(normalizedRegionToPixels(positionLootRegion(1, 1, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 3168,
            y: 1260,
            width: 272,
            height: 180,
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

        expect(search).toEqual({ x: 2247, y: 816, width: 800, height: 600 });
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
            { x: 2247, y: 840, width: 800, height: 600 },
            { x: 2511, y: 1026, width: 272, height: 180 },
        ]) {
            expect(normalizedRegionToPixels(pixelRegionToNormalized(pixels, 3440, 1440), 3440, 1440)).toEqual(pixels);
        }
    });

    it("rejects unsupported search geometry and non-exact normal regions", () => {
        expect(() => positionLootSearchRegion(0.5, 0.5, 2561, 1440)).toThrow(/3440x1440/);
        expect(() =>
            searchRegionAroundLootRegion(
                pixelRegionToNormalized({ x: 10, y: 10, width: 341, height: 226 }, 3440, 1440),
                3440,
                1440,
            ),
        ).toThrow(/272x180/);
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
        for (const kind of ["normal", "rare"] as const) {
            const region = defaultLootRegion(width, height, 80, kind);
            const exact = normalizedRegionToPixels(region, width, height);
            const search = normalizedRegionToPixels(
                searchRegionAroundLootRegion(region, width, height, kind),
                width,
                height,
            );
            expect(search.x).toBeLessThanOrEqual(exact.x);
            expect(search.y).toBeLessThanOrEqual(exact.y);
            expect(search.x + 800).toBeGreaterThanOrEqual(exact.x + exact.width);
            expect(search.y + 600).toBeGreaterThanOrEqual(exact.y + exact.height);
        }
    }
});

describe("visible loot guide placement", () => {
    for (const scale of [80, 100] as const) {
        for (const kind of ["normal", "rare"] as const) {
            it(`centers the ${kind} guide at ${scale}% without resizing OCR pixels`, () => {
                const guide = lootAlignmentGuide(scale, kind);
                const region = positionLootRegion(0.4, 0.6, 3440, 1440, scale, kind);
                const crop = normalizedRegionToPixels(region, 3440, 1440);
                expect(crop.width).toBe(lootRegionSize(scale, kind).width);
                expect(crop.height).toBe(lootRegionSize(scale, kind).height);
                expect(Math.abs(crop.x + guide.x + guide.width / 2 - 0.4 * 3440)).toBeLessThanOrEqual(0.5);
                expect(Math.abs(crop.y + guide.y + guide.height / 2 - 0.6 * 1440)).toBeLessThanOrEqual(0.5);
                const edge = normalizedRegionToPixels(positionLootRegion(0, 1, 3440, 1440, scale, kind), 3440, 1440);
                expect(edge.x).toBe(0);
                expect(edge.y + edge.height).toBe(1440);
            });
        }
    }
});

describe("rare loot XML placement", () => {
    it("centers the rare crop on the saved panel position from the 3440x1440/80% XML layout", () => {
        // Reference Index="161" entry: LeftTop, PosX=96, PosY=483. The confirmed crop in a recording was (78, 401).
        const region = positionLootRegion(0.07112970948, 0.3039378822, 3440, 1440, 80, "rare");
        expect(normalizedRegionToPixels(region, 3440, 1440)).toEqual({ x: 75, y: 402, width: 340, height: 72 });
    });
});

describe("normal loot XML placement", () => {
    it("matches the reported automatic placement from the 3440x1440/80% XML layout", () => {
        // Reported Index="159" entry: RightBottom, PosX=-331, PosY=136.
        const relativeX = 0.9183720946;
        const relativeY = 0.8078845143;
        expect(normalizedRegionToPixels(positionLootRegion(relativeX, relativeY, 3440, 1440, 80), 3440, 1440)).toEqual({
            x: 3023,
            y: 1073,
            width: 272,
            height: 180,
        });
        const region = positionNormalLootFromLayout(relativeX, relativeY, 3440, 1440, 80);
        const pixels = normalizedRegionToPixels(region, 3440, 1440);
        expect(pixels).toEqual({ x: 3048, y: 1094, width: 272, height: 180 });
        expect(lootAlignmentGuide(80).rowCenters.map((center) => pixels.y + center)).toEqual([
            1106, 1145, 1184, 1223, 1262,
        ]);
    });

    it("scales both corrections with game UI scale, independently of source resolution", () => {
        for (const [width, height] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            for (const scale of [80, 100] as const) {
                const before = normalizedRegionToPixels(
                    positionLootRegion(0.5, 0.5, width, height, scale),
                    width,
                    height,
                );
                const imported = normalizedRegionToPixels(
                    positionNormalLootFromLayout(0.5, 0.5, width, height, scale),
                    width,
                    height,
                );
                expect(imported).toEqual({
                    ...before,
                    x: before.x + (scale === 80 ? 25 : 31),
                    y: before.y + (scale === 80 ? 21 : 26),
                });
            }
        }
    });

    it("clamps the corrected crop at source boundaries without shrinking it", () => {
        for (const scale of [80, 100] as const) {
            const size = lootRegionSize(scale);
            for (const [x, y] of [
                [0, 0],
                [0, 1],
                [1, 0],
                [1, 1],
            ]) {
                expect(
                    normalizedRegionToPixels(positionNormalLootFromLayout(x, y, 3440, 1440, scale), 3440, 1440),
                ).toEqual({
                    x: x === 0 ? 0 : 3440 - size.width,
                    y: y === 0 ? 0 : 1440 - size.height,
                    ...size,
                });
            }
        }
    });
});
