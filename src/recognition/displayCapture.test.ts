import { describe, expect, it } from "vitest";
import { displayCaptureErrorMessage, stopDisplayCapture } from "./displayCapture";

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
