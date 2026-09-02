import { describe, expect, it } from "vitest";
import {
    defaultLootRegion,
    displayCaptureErrorMessage,
    isSupportedLootSource,
    lootRegionSize,
    normalizedRegionToPixels,
    nudgeLootRegion,
    positionLootRegion,
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
