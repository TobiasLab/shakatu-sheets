import { describe, expect, it, vi } from "vitest";
import {
    DisplayCaptureTimeoutError,
    displayCaptureErrorMessage,
    stopDisplayCapture,
    waitForDisplayCapture,
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

    it("stops waiting when the browser leaves a capture request unresolved", async () => {
        vi.useFakeTimers();
        try {
            const result = waitForDisplayCapture(new Promise<MediaStream>(() => {}), 1_000);
            const rejection = expect(result).rejects.toBeInstanceOf(DisplayCaptureTimeoutError);

            await vi.advanceTimersByTimeAsync(1_000);

            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });
});
