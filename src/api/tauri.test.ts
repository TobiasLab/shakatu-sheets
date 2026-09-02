import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(),
    onMessage: undefined as ((message: ArrayBuffer) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
    Channel: class {
        constructor(onMessage: (message: ArrayBuffer) => void) {
            tauri.onMessage = onMessage;
        }
    },
    invoke: tauri.invoke,
    isTauri: () => true,
}));

import { parseNativeCaptureMessage, startNativeDisplayCapture } from "./tauri";

function message(kind: number, width: number, height: number, sourceWidth: number, sourceHeight: number) {
    const buffer = new ArrayBuffer(40 + width * height * 4);
    const header = new DataView(buffer);
    const cropX = kind === 2 || kind === 3 ? Math.min(2433, sourceWidth - width) : 0;
    const cropY = kind === 2 || kind === 3 ? Math.min(990, sourceHeight - height) : 0;
    for (const [index, value] of [2, kind, 7, 11, width, height, sourceWidth, sourceHeight, cropX, cropY].entries()) {
        header.setUint32(index * 4, value, true);
    }
    return buffer;
}

describe("native capture frame protocol", () => {
    beforeEach(() => {
        tauri.invoke.mockReset();
        tauri.onMessage = undefined;
    });

    it("parses preview, normal region, and rare region frames", () => {
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
        expect(parseNativeCaptureMessage(message(3, 400, 100, 2560, 1440))).toMatchObject({
            kind: "rare-region",
            width: 400,
            height: 100,
            sourceWidth: 2560,
            sourceHeight: 1440,
            cropX: 2160,
            cropY: 990,
        });
        expect(parseNativeCaptureMessage(message(3, 500, 125, 1920, 1080))).toMatchObject({
            kind: "rare-region",
            width: 500,
            height: 125,
        });
    });

    it("rejects malformed and unsupported frames", () => {
        expect(() => parseNativeCaptureMessage(new ArrayBuffer(39))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(1, 641, 1, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 363, 311, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 400, 350, 1920, 1080))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 400, 100, 1920, 1080))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(2, 362, 311, 1280, 720))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(3, 362, 311, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(3, 401, 100, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(3, 400, 100, 1280, 720))).toThrow(/invalid/);
        const outOfBounds = message(3, 400, 100, 1920, 1080);
        new DataView(outOfBounds).setUint32(32, 1600, true);
        expect(() => parseNativeCaptureMessage(outOfBounds)).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(4, 1, 1, 1, 1))).toThrow(/invalid/);

        const unsupported = message(1, 1, 1, 1, 1);
        new DataView(unsupported).setUint32(0, 1, true);
        expect(() => parseNativeCaptureMessage(unsupported)).toThrow(/unsupported/);
    });

    it("decodes native capture errors", () => {
        const text = new TextEncoder().encode("capture failed");
        const buffer = new ArrayBuffer(40 + text.length);
        const header = new DataView(buffer);
        header.setUint32(0, 2, true);
        new Uint8Array(buffer, 40).set(text);
        expect(parseNativeCaptureMessage(buffer)).toEqual({ kind: "error", message: "capture failed" });
    });

    it("acknowledges rare region frames as kind 3", () => {
        const onFrame = vi.fn();
        startNativeDisplayCapture(null, onFrame, vi.fn());

        tauri.onMessage?.(message(3, 400, 100, 2560, 1440));

        expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ kind: "rare-region" }));
        expect(tauri.invoke).toHaveBeenLastCalledWith("acknowledge_native_display_frame", {
            captureId: 7,
            batchId: 11,
            kind: 3,
        });
    });

    it("reports acknowledgement failures", async () => {
        tauri.invoke.mockImplementation((command: string) =>
            command === "acknowledge_native_display_frame"
                ? Promise.reject(new Error("channel closed"))
                : Promise.resolve(),
        );
        const onError = vi.fn();
        startNativeDisplayCapture(null, vi.fn(), onError);

        tauri.onMessage?.(message(3, 400, 100, 2560, 1440));

        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith("Native display capture acknowledgement failed: channel closed"),
        );
    });
});
