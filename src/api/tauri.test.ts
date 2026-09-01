import { describe, expect, it } from "vitest";
import { parseNativeCaptureMessage } from "./tauri";

function message(kind: number, width: number, height: number, sourceWidth: number, sourceHeight: number) {
    const buffer = new ArrayBuffer(40 + width * height * 4);
    const header = new DataView(buffer);
    const cropX = kind === 2 ? Math.min(2433, sourceWidth - width) : 0;
    const cropY = kind === 2 ? Math.min(990, sourceHeight - height) : 0;
    for (const [index, value] of [1, kind, 7, 11, width, height, sourceWidth, sourceHeight, cropX, cropY].entries()) {
        header.setUint32(index * 4, value, true);
    }
    return buffer;
}

describe("native capture frame protocol", () => {
    it("parses preview and native region frames", () => {
        expect(parseNativeCaptureMessage(message(1, 2, 1, 3440, 1440))).toMatchObject({
            kind: "preview",
            width: 2,
            height: 1,
            sourceWidth: 3440,
            sourceHeight: 1440,
            captureId: 7,
            batchId: 11,
            cropX: 0,
            cropY: 0,
        });
        expect(parseNativeCaptureMessage(message(2, 362, 311, 3440, 1440))).toMatchObject({
            kind: "region",
            width: 362,
            height: 311,
            cropX: 2433,
            cropY: 990,
        });
        expect(parseNativeCaptureMessage(message(2, 453, 389, 1920, 1080))).toMatchObject({
            kind: "region",
            width: 453,
            height: 389,
            sourceWidth: 1920,
            sourceHeight: 1080,
        });
    });

    it("rejects malformed and unsupported frames", () => {
        expect(() => parseNativeCaptureMessage(new ArrayBuffer(39))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(1, 641, 1, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 363, 311, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 400, 350, 1920, 1080))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 362, 311, 1280, 720))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(3, 1, 1, 1, 1))).toThrow(/invalid/);

        const unsupported = message(1, 1, 1, 1, 1);
        new DataView(unsupported).setUint32(0, 2, true);
        expect(() => parseNativeCaptureMessage(unsupported)).toThrow(/unsupported/);
    });

    it("decodes native capture errors", () => {
        const text = new TextEncoder().encode("capture failed");
        const buffer = new ArrayBuffer(40 + text.length);
        const header = new DataView(buffer);
        header.setUint32(0, 1, true);
        new Uint8Array(buffer, 40).set(text);
        expect(parseNativeCaptureMessage(buffer)).toEqual({ kind: "error", message: "capture failed" });
    });
});
