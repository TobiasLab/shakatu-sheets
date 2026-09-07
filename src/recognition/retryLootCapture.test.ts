import { describe, expect, it, vi } from "vitest";
import type { LootReviewCapture } from "./liveLoot";
import type { LiveLootTesseractOcr } from "./liveLootOcr";
import { retryLootCapture } from "./retryLootCapture";

const capture: LootReviewCapture = {
    width: 40,
    height: 20,
    pixels: new Uint8ClampedArray(40 * 20 * 4),
    bounds: { left: 10, right: 35, top: 0, bottom: 20 },
};
const dictionary = ["Black Stone", "Ancient Spirit Dust"];

function worker(readings = [["Black Stone x 3", "Black Stone x 3", "Black Stone x 3"]]) {
    return {
        readText: vi.fn<LiveLootTesseractOcr["readText"]>().mockResolvedValue(readings),
        terminate: vi.fn<LiveLootTesseractOcr["terminate"]>().mockResolvedValue(undefined),
    };
}

describe("saved capture OCR", () => {
    it.each(["normal", "rare"] as const)(
        "reads exactly the saved %s frame and returns a suggestion",
        async (source) => {
            const ocr = worker();
            const controller = new AbortController();
            const suggestion = await retryLootCapture(capture, source, dictionary, controller.signal, async () => ocr);
            expect(suggestion).toMatchObject({ item: "Black Stone", quantity: 3 });
            expect(ocr.readText).toHaveBeenCalledExactlyOnceWith(
                [
                    expect.objectContaining({
                        roi: capture,
                        bounds: capture.bounds,
                        textColor: source === "rare" ? "gold" : "white",
                    }),
                ],
                controller.signal,
            );
            expect(ocr.terminate).toHaveBeenCalledOnce();
        },
    );

    it.each([
        [["", "", ""]],
        [["Black Stone x 3", "Black Stone x 4", "Black Stone x 3"]],
        [["Unknown Object x 3", "Unknown Object x 3", "Unknown Object x 3"]],
    ])("leaves unreadable or conflicting results for manual entry", async (readings) => {
        const ocr = worker([readings]);
        expect(
            await retryLootCapture(capture, "normal", dictionary, new AbortController().signal, async () => ocr),
        ).toBeNull();
        expect(ocr.terminate).toHaveBeenCalledOnce();
    });

    it("terminates the worker after an OCR failure", async () => {
        const ocr = worker();
        ocr.readText.mockRejectedValue(new Error("OCR unavailable"));
        await expect(
            retryLootCapture(capture, "normal", dictionary, new AbortController().signal, async () => ocr),
        ).rejects.toThrow("OCR unavailable");
        expect(ocr.terminate).toHaveBeenCalledOnce();
    });

    it("preserves the OCR error when worker cleanup also fails", async () => {
        const ocr = worker();
        ocr.readText.mockRejectedValue(new Error("OCR unavailable"));
        ocr.terminate.mockRejectedValue(new Error("Worker cleanup failed"));
        await expect(
            retryLootCapture(capture, "normal", dictionary, new AbortController().signal, async () => ocr),
        ).rejects.toThrow("OCR unavailable");
        expect(ocr.terminate).toHaveBeenCalledOnce();
    });

    it("does not start a job that was already cancelled", async () => {
        const controller = new AbortController();
        controller.abort();
        const create = vi.fn();
        await expect(retryLootCapture(capture, "normal", dictionary, controller.signal, create)).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(create).not.toHaveBeenCalled();
    });

    it("cleans up a worker whose startup finishes after the capture is cleared", async () => {
        const controller = new AbortController();
        const ocr = worker();
        await expect(
            retryLootCapture(capture, "normal", dictionary, controller.signal, async () => {
                controller.abort();
                return ocr;
            }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(ocr.readText).not.toHaveBeenCalled();
        expect(ocr.terminate).toHaveBeenCalledOnce();
    });

    it("discards late results when cancelled during recognition", async () => {
        const controller = new AbortController();
        const ocr = worker();
        ocr.readText.mockImplementation(async () => {
            controller.abort();
            return [["Black Stone x 3"]];
        });
        await expect(
            retryLootCapture(capture, "normal", dictionary, controller.signal, async () => ocr),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(ocr.terminate).toHaveBeenCalledOnce();
    });
});
