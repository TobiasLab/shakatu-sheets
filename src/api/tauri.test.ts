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

import {
    debugRoiSampleCollectionStatus,
    type LootCaptureSettings,
    type NativeCaptureSelection,
    parseNativeCaptureMessage,
    setNativeDisplayCapturePreviewEnabled,
    setNativeDisplayCaptureRegion,
    startDebugRoiSampleCollection,
    startNativeDisplayCapture,
    stopDebugRoiSampleCollection,
    stopNativeDisplayCapture,
} from "./tauri";

function message(kind: number, width: number, height: number, sourceWidth: number, sourceHeight: number) {
    const buffer = new ArrayBuffer(40 + width * height * 4);
    const header = new DataView(buffer);
    const cropX = kind >= 2 ? Math.min(2433, sourceWidth - width) : 0;
    const cropY = kind >= 2 ? Math.min(990, sourceHeight - height) : 0;
    for (const [index, value] of [3, kind, 7, 11, width, height, sourceWidth, sourceHeight, cropX, cropY].entries()) {
        header.setUint32(index * 4, value, true);
    }
    return buffer;
}

describe("native capture frame protocol", () => {
    beforeEach(() => {
        tauri.invoke.mockReset();
        tauri.onMessage = undefined;
    });

    it("parses preview, normal region, rare region, and search region frames", () => {
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
        expect(parseNativeCaptureMessage(message(4, 800, 600, 3440, 1440))).toMatchObject({
            kind: "search-region",
            width: 800,
            height: 600,
            sourceWidth: 3440,
            sourceHeight: 1440,
            cropX: 2433,
            cropY: 840,
        });
    });

    it("accepts bounded search frames at each supported source resolution", () => {
        for (const [width, height] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            const frame = message(4, 800, 600, width, height);
            new DataView(frame).setUint32(32, width - 800, true);
            new DataView(frame).setUint32(36, height - 600, true);
            expect(parseNativeCaptureMessage(frame)).toMatchObject({
                kind: "search-region",
                sourceWidth: width,
                sourceHeight: height,
                cropX: width - 800,
                cropY: height - 600,
            });
            new DataView(frame).setUint32(32, width - 799, true);
            expect(() => parseNativeCaptureMessage(frame)).toThrow(/invalid/);
        }
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
        expect(() => parseNativeCaptureMessage(message(4, 799, 600, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(4, 800, 599, 3440, 1440))).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(4, 800, 600, 2561, 1440))).toThrow(/invalid/);
        const searchOutOfBounds = message(4, 800, 600, 3440, 1440);
        new DataView(searchOutOfBounds).setUint32(32, 2641, true);
        expect(() => parseNativeCaptureMessage(searchOutOfBounds)).toThrow(/invalid/);
        expect(() => parseNativeCaptureMessage(message(5, 1, 1, 1, 1))).toThrow(/invalid/);

        const unsupported = message(1, 1, 1, 1, 1);
        new DataView(unsupported).setUint32(0, 2, true);
        expect(() => parseNativeCaptureMessage(unsupported)).toThrow(/unsupported/);
    });

    it("decodes native capture errors", () => {
        const text = new TextEncoder().encode("capture failed");
        const buffer = new ArrayBuffer(40 + text.length);
        const header = new DataView(buffer);
        header.setUint32(0, 3, true);
        new Uint8Array(buffer, 40).set(text);
        expect(parseNativeCaptureMessage(buffer)).toEqual({ kind: "error", message: "capture failed" });
    });

    it("acknowledges rare region frames as kind 3", () => {
        const onFrame = vi.fn();
        startNativeDisplayCapture(1, null, onFrame, vi.fn());

        tauri.onMessage?.(message(3, 400, 100, 2560, 1440));

        expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ kind: "rare-region" }));
        expect(tauri.invoke).toHaveBeenLastCalledWith("acknowledge_native_display_frame", {
            captureId: 7,
            batchId: 11,
            kind: 3,
        });
    });

    it("acknowledges search region frames as kind 4", () => {
        const onFrame = vi.fn();
        startNativeDisplayCapture(1, null, onFrame, vi.fn());

        tauri.onMessage?.(message(4, 800, 600, 3440, 1440));

        expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ kind: "search-region" }));
        expect(tauri.invoke).toHaveBeenLastCalledWith("acknowledge_native_display_frame", {
            captureId: 7,
            batchId: 11,
            kind: 4,
        });
    });

    it("sends discriminated search and region selections", () => {
        const search: NativeCaptureSelection = {
            mode: "search",
            region: { x: 0.5, y: 0.5, width: 800 / 3440, height: 600 / 1440 },
            sourceWidth: 3440,
            sourceHeight: 1440,
            uiScalePercent: 80,
        };
        const settings: LootCaptureSettings = {
            region: { x: 2433 / 3440, y: 990 / 1440, width: 362 / 3440, height: 311 / 1440 },
            rareRegionConfirmed: false,
            sourceWidth: 3440,
            sourceHeight: 1440,
            uiScalePercent: 80,
        };

        startNativeDisplayCapture(17, search, vi.fn(), vi.fn());
        expect(tauri.invoke).toHaveBeenLastCalledWith("start_native_display_capture", {
            captureToken: 17,
            frames: expect.anything(),
            selection: search,
        });
        setNativeDisplayCaptureRegion(17, { mode: "regions", settings });
        expect(tauri.invoke).toHaveBeenLastCalledWith("set_native_display_capture_region", {
            captureToken: 17,
            selection: { mode: "regions", settings },
        });
        stopNativeDisplayCapture(17);
        expect(tauri.invoke).toHaveBeenLastCalledWith("stop_native_display_capture", { captureToken: 17 });
        setNativeDisplayCaptureRegion(17, settings);
        expect(tauri.invoke).toHaveBeenLastCalledWith("set_native_display_capture_region", {
            captureToken: 17,
            selection: { mode: "regions", settings },
        });
        setNativeDisplayCapturePreviewEnabled(17, false);
        expect(tauri.invoke).toHaveBeenLastCalledWith("set_native_display_capture_preview_enabled", {
            captureToken: 17,
            enabled: false,
        });
    });

    it("controls debug ROI sample collection for the active capture", () => {
        startDebugRoiSampleCollection(17);
        expect(tauri.invoke).toHaveBeenLastCalledWith("start_debug_roi_sample_collection", { captureToken: 17 });

        stopDebugRoiSampleCollection(17);
        expect(tauri.invoke).toHaveBeenLastCalledWith("stop_debug_roi_sample_collection", { captureToken: 17 });

        debugRoiSampleCollectionStatus();
        expect(tauri.invoke).toHaveBeenLastCalledWith("debug_roi_sample_collection_status");
    });

    it("reports acknowledgement failures", async () => {
        tauri.invoke.mockImplementation((command: string) =>
            command === "acknowledge_native_display_frame"
                ? Promise.reject(new Error("channel closed"))
                : Promise.resolve(),
        );
        const onError = vi.fn();
        startNativeDisplayCapture(1, null, vi.fn(), onError);

        tauri.onMessage?.(message(3, 400, 100, 2560, 1440));

        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith("Native display capture acknowledgement failed: channel closed"),
        );
    });

    it("does not acknowledge malformed search frames", () => {
        const onError = vi.fn();
        startNativeDisplayCapture(1, null, vi.fn(), onError);
        tauri.invoke.mockClear();

        tauri.onMessage?.(message(4, 799, 600, 3440, 1440));

        expect(onError).toHaveBeenCalledWith(expect.stringMatching(/invalid/));
        expect(tauri.invoke).not.toHaveBeenCalledWith("acknowledge_native_display_frame", expect.anything());
    });
});

describe("native capture capability routing", () => {
    it("uses backend capabilities instead of the webview user agent", async () => {
        const { nativeCaptureCapabilities } = await import("./tauri");
        const capabilities = {
            backend: "windows",
            available: false,
            reason: "Disabled by policy",
            debugRoiSamples: false,
        };
        tauri.invoke.mockResolvedValueOnce(capabilities);
        expect(await nativeCaptureCapabilities()).toEqual(capabilities);
        expect(tauri.invoke).toHaveBeenLastCalledWith("native_capture_capabilities");
    });
});
