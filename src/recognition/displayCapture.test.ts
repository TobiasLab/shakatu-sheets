import { describe, expect, it } from "vitest";
import {
    defaultLootRegion,
    displayCaptureErrorMessage,
    isSupportedLootSource,
    normalizedRegionToPixels,
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
        expect(normalizedRegionToPixels(defaultLootRegion(), 3440, 1440)).toEqual({
            x: 2433,
            y: 990,
            width: 362,
            height: 311,
        });
    });

    it("positions the fixed crop and clamps it to source bounds", () => {
        expect(normalizedRegionToPixels(positionLootRegion(0, 0, 3440, 1440), 3440, 1440)).toEqual({
            x: 0,
            y: 0,
            width: 362,
            height: 311,
        });
        expect(normalizedRegionToPixels(positionLootRegion(1, 1, 3440, 1440), 3440, 1440)).toEqual({
            x: 3078,
            y: 1129,
            width: 362,
            height: 311,
        });
    });

    it("rejects unsupported sources and malformed normalized bounds", () => {
        expect(isSupportedLootSource(3440, 1440)).toBe(true);
        expect(isSupportedLootSource(1920, 1080)).toBe(false);
        expect(() => positionLootRegion(0.5, 0.5, 1920, 1080)).toThrow(/supported/);
        expect(() => normalizedRegionToPixels({ x: 0.9, y: 0, width: 0.2, height: 1 }, 3440, 1440)).toThrow(/invalid/);
    });
});
