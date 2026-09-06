import { describe, expect, it } from "vitest";
import { normalizedRegionToPixels } from "./displayCapture";
import type { LootSearchFrame } from "./liveLootLocalization";
import { RareLootLocalizer } from "./rareLootLocalization";

function frame(width = 2560, height = 1440, x = 200, y = 200): LootSearchFrame {
    const pixels = new Uint8ClampedArray(800 * 600 * 4);
    const paint = (left: number, top: number, right: number, bottom: number) => {
        for (let py = top; py < bottom; py += 1) {
            for (let px = left; px < right; px += 1) pixels.set([180, 125, 35, 255], (py * 800 + px) * 4);
        }
    };
    paint(x + 65, y + 35, x + 370, y + 80);
    paint(x + 120, y + 34, x + 320, y + 38);
    return {
        width: 800,
        height: 600,
        pixels,
        sourceWidth: width,
        sourceHeight: height,
        cropX: width - 800,
        cropY: height - 600,
    };
}

function lock(input: LootSearchFrame) {
    const localizer = new RareLootLocalizer();
    expect(localizer.pushFrame(input)).toBeNull();
    expect(localizer.pushFrame(input)).toBeNull();
    return localizer.pushFrame(input);
}

describe("rare loot localization", () => {
    it.each([
        [3440, 1440],
        [2560, 1440],
        [1920, 1080],
    ])("places a stable banner at %ix%i using source pixels", (width, height) => {
        for (const [x, y] of [
            [0, 0],
            [200, 200],
            [400, 500],
        ]) {
            const input = frame(width, height, x, y);
            const result = lock(input);
            if (!result) throw new Error("Expected stable rare placement");
            expect(normalizedRegionToPixels(result.region, width, height)).toEqual({
                x: input.cropX + x,
                y: input.cropY + y,
                width: 400,
                height: 100,
            });
            expect(result.replayFrames).toEqual([]);
        }
    });

    it("rejects blank, gold scenery, and ambiguous banners", () => {
        const blank = frame();
        blank.pixels.fill(0);
        expect(lock(blank)).toBeNull();
        const gold = frame();
        for (let i = 0; i < gold.pixels.length; i += 4) gold.pixels.set([180, 125, 35, 255], i);
        expect(lock(gold)).toBeNull();
        const ambiguous = frame(2560, 1440, 200, 20);
        const other = frame(2560, 1440, 200, 300);
        for (let i = 0; i < ambiguous.pixels.length; i += 1) ambiguous.pixels[i] ||= other.pixels[i];
        expect(lock(ambiguous)).toBeNull();
    });

    it("clears stability on source changes, missing signals, and cancellation", () => {
        const localizer = new RareLootLocalizer();
        expect(localizer.pushFrame(frame())).toBeNull();
        expect(localizer.pushFrame(frame())).toBeNull();
        expect(localizer.pushFrame(frame(1920, 1080))).toBeNull();
        localizer.clear();
        expect(localizer.pushFrame(frame(1920, 1080))).toBeNull();
        const blank = frame(1920, 1080);
        blank.pixels.fill(0);
        expect(localizer.pushFrame(blank)).toBeNull();
        expect(localizer.pushFrame(frame(1920, 1080))).toBeNull();
        expect(localizer.pushFrame(frame(1920, 1080))).toBeNull();
        expect(localizer.pushFrame(frame(1920, 1080))).not.toBeNull();
    });

    it("does not treat a slowly drifting banner as a stable location", () => {
        const localizer = new RareLootLocalizer();
        for (const x of [200, 203, 206, 209, 212]) {
            expect(localizer.pushFrame(frame(2560, 1440, x))).toBeNull();
        }
        expect(localizer.pushFrame(frame(2560, 1440, 212))).toBeNull();
        expect(localizer.pushFrame(frame(2560, 1440, 212))).not.toBeNull();
    });

    it("validates search frame dimensions and bounds", () => {
        expect(() => lock({ ...frame(), cropX: 2560 })).toThrow();
        expect(() => lock({ ...frame(), pixels: new Uint8ClampedArray(4) })).toThrow();
    });
});

it("keeps rare localization at eight evaluations per second during 16 FPS capture", () => {
    const localizer = new RareLootLocalizer(80, 16);
    const input = frame();
    for (let index = 0; index < 4; index++) expect(localizer.pushFrame(input)).toBeNull();
    expect(localizer.pushFrame(input)).not.toBeNull();
    localizer.clear();
    for (let index = 0; index < 4; index++) expect(localizer.pushFrame(input)).toBeNull();
    expect(localizer.pushFrame(input)).not.toBeNull();
});
