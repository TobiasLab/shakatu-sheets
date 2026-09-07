import { expect, it } from "vitest";
import { copyLootReviewCapture, type LiveLootOcrFrame } from "./liveLoot";

it("copies the uncertain row independently without retaining the full ROI or diagnostic metadata", () => {
    const pixels = new Uint8ClampedArray(4 * 6 * 4).map((_, index) => index);
    const frame: LiveLootOcrFrame = {
        frame: 1,
        roi: { width: 4, height: 6, pixels, sample: { captureToken: 1, collectionPath: "debug", batchId: 1 } },
        observation: {
            slot: 0,
            centerY: 3,
            score: 1,
            fingerprint: { full: new Uint8Array(), quantity: new Uint8Array() },
        },
        bounds: { left: 1, right: 3, top: 2, bottom: 4 },
    };
    const capture = copyLootReviewCapture(frame);
    expect(capture).toEqual({
        width: 4,
        height: 2,
        pixels: pixels.slice(32, 64),
        bounds: { left: 1, right: 3, top: 0, bottom: 2 },
    });
    pixels.fill(0);
    expect(capture.pixels[0]).toBe(32);
});

it.each([4, 40, 76])("keeps retry bounds on the observed row near y=%s without adjacent text", (centerY) => {
    const capture = copyLootReviewCapture({
        frame: 0,
        roi: { width: 100, height: 80, pixels: new Uint8ClampedArray(100 * 80 * 4) },
        observation: {
            slot: 0,
            centerY,
            score: 1,
            fingerprint: { full: new Uint8Array(), quantity: new Uint8Array() },
        },
    });
    const cropTop = Math.max(0, centerY - 24);
    expect(capture.bounds).toEqual({
        left: 25,
        right: 100,
        top: Math.max(0, centerY - 12) - cropTop,
        bottom: Math.min(80, centerY + 12) - cropTop,
    });
    expect(capture.pixels.length).toBe(capture.width * capture.height * 4);
});
