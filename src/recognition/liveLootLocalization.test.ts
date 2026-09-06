import { describe, expect, it } from "vitest";
import { normalizedRegionToPixels } from "./displayCapture";
import { LiveLootCoordinator, type LiveLootRecognitionResult } from "./liveLoot";
import { type LootSearchFrame, NormalLootLocalizer } from "./liveLootLocalization";

const SEARCH_WIDTH = 800;
const SEARCH_HEIGHT = 600;

function searchFrame(
    regionX: number | null,
    cropY = 100,
    sourceCropX = 1000,
    sourceCropY = 500,
    rowCount = 2,
    marker = 0,
): LootSearchFrame {
    const pixels = new Uint8ClampedArray(SEARCH_WIDTH * SEARCH_HEIGHT * 4);
    if (regionX !== null) {
        for (const center of [48, 87, 126, 165, 204].slice(5 - rowCount)) {
            for (let y = cropY + center - 6; y < cropY + center + 7; y += 1) {
                for (let x = regionX - 19; x < regionX + 249; x += 1) {
                    const offset = (y * SEARCH_WIDTH + x) * 4;
                    pixels[offset] = 220;
                    pixels[offset + 1] = 220;
                    pixels[offset + 2] = 220;
                    pixels[offset + 3] = 255;
                }
            }
        }
        const markerOffset = (cropY * SEARCH_WIDTH + regionX) * 4;
        pixels.set([marker, marker + 1, marker + 2, 255], markerOffset);
    }
    return {
        width: SEARCH_WIDTH,
        height: SEARCH_HEIGHT,
        pixels,
        sourceWidth: 3440,
        sourceHeight: 1440,
        cropX: sourceCropX,
        cropY: sourceCropY,
    };
}

function locate(frames: LootSearchFrame[]) {
    const localizer = new NormalLootLocalizer();
    let result = null;
    for (const frame of frames) result = localizer.pushFrame(frame) ?? result;
    return result;
}

describe("normal loot localization", () => {
    it("locks a stable known origin and returns its exact normalized region", () => {
        const result = locate(Array.from({ length: 6 }, (_, index) => searchFrame(219, 100, 1000, 500, 2, index + 1)));

        expect(result).not.toBeNull();
        expect(normalizedRegionToPixels(result?.region ?? { x: 0, y: 0, width: 1, height: 1 }, 3440, 1440)).toEqual({
            x: 1219,
            y: 600,
            width: 362,
            height: 311,
        });
        expect(result?.replayFrames).toHaveLength(6);
    });

    it("accounts for translated native search-frame origins", () => {
        const result = locate(Array.from({ length: 6 }, () => searchFrame(299, 180, 1800, 700)));

        expect(normalizedRegionToPixels(result?.region ?? { x: 0, y: 0, width: 1, height: 1 }, 3440, 1440)).toEqual({
            x: 2099,
            y: 880,
            width: 362,
            height: 311,
        });
    });

    it("refuses one frame, empty frames, and one-row noise", () => {
        expect(locate([searchFrame(219)])).toBeNull();
        expect(locate(Array.from({ length: 8 }, () => searchFrame(null)))).toBeNull();
        expect(locate(Array.from({ length: 8 }, () => searchFrame(219, 100, 1000, 500, 1)))).toBeNull();
    });

    it("clusters jittered candidates and returns upper-median coordinates", () => {
        const positions = [
            { x: 215, y: 96 },
            { x: 219, y: 100 },
            { x: 223, y: 103 },
        ];
        const frames = positions.flatMap((position) => [searchFrame(null), searchFrame(position.x, position.y)]);
        const result = locate(frames);

        expect(
            normalizedRegionToPixels(result?.region ?? { x: 0, y: 0, width: 1, height: 1 }, 3440, 1440),
        ).toMatchObject({
            x: 1219,
            y: 600,
        });
    });

    it("crops exact replay content from every retained overlapping frame", () => {
        const result = locate(Array.from({ length: 6 }, (_, index) => searchFrame(219, 100, 1000, 500, 2, index + 10)));

        expect(result?.replayFrames.map((frame) => Array.from(frame.pixels.subarray(0, 4)))).toEqual([
            [10, 11, 12, 255],
            [11, 12, 13, 255],
            [12, 13, 14, 255],
            [13, 14, 15, 255],
            [14, 15, 16, 255],
            [15, 16, 17, 255],
        ]);
        expect(result?.replayFrames.every((frame) => frame.width === 362 && frame.height === 311)).toBe(true);
    });

    it("uses the first retained search frame as the event baseline", async () => {
        const result = locate(Array.from({ length: 6 }, () => searchFrame(219)));
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: { width: 362, height: 311, maxRows: 5, bottomCenter: 204, spacing: 39, rowThreshold: 196 },
            dictionary: ["Black Stone"],
            readText: async (frames) => frames.map(() => ["Black Stone x 2"]),
            onResult: (recognized) => results.push(recognized),
        });

        for (const frame of result?.replayFrames ?? []) coordinator.pushFrame(frame);
        await coordinator.finish();

        expect(results).toHaveLength(0);
    });

    it("replays notifications that appear after the first retained search frame", async () => {
        const result = locate([
            searchFrame(null),
            searchFrame(null),
            ...Array.from({ length: 6 }, () => searchFrame(219)),
        ]);
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: { width: 362, height: 311, maxRows: 5, bottomCenter: 204, spacing: 39, rowThreshold: 196 },
            dictionary: ["Black Stone"],
            readText: async (frames) => frames.map(() => ["Black Stone x 2"]),
            onResult: (recognized) => results.push(recognized),
        });

        for (const frame of result?.replayFrames ?? []) coordinator.pushFrame(frame);
        await coordinator.finish();

        expect(results).toHaveLength(2);
        expect(results.every((recognized) => recognized.status === "recognized")).toBe(true);
    });

    it("bounds retained history and clear releases all state", () => {
        const localizer = new NormalLootLocalizer();
        for (let index = 0; index < 26; index += 1) localizer.pushFrame(searchFrame(null));

        expect(localizer.retainedFrameCount).toBe(12);
        expect(localizer.evaluatedCandidateCount).toBe(4);
        localizer.clear();
        expect(localizer.retainedFrameCount).toBe(0);
        expect(localizer.evaluatedCandidateCount).toBe(0);
    });

    it("rejects malformed dimensions, buffers, source metadata, and crop metadata", () => {
        const localizer = new NormalLootLocalizer();
        const frame = searchFrame(null);

        expect(() => localizer.pushFrame({ ...frame, width: 799 })).toThrow(/800x600/);
        expect(() => localizer.pushFrame({ ...frame, pixels: frame.pixels.subarray(4) })).toThrow(/RGBA/);
        expect(() => localizer.pushFrame({ ...frame, sourceWidth: 2561 })).toThrow(/supported source/);
        expect(() => localizer.pushFrame({ ...frame, cropX: 2641 })).toThrow(/3440x1440/);
    });
});

for (const [sourceWidth, sourceHeight] of [
    [3440, 1440],
    [2560, 1440],
    [1920, 1080],
]) {
    it(`localizes exact native pixels and replay at both edges of ${sourceWidth}x${sourceHeight}`, () => {
        for (const [cropX, cropY] of [
            [0, 0],
            [sourceWidth - 800, sourceHeight - 600],
        ]) {
            const frames = Array.from({ length: 6 }, (_, index) => ({
                ...searchFrame(219, 100, cropX, cropY, 2, index + 10),
                sourceWidth,
                sourceHeight,
            }));
            const result = locate(frames);
            expect(result).not.toBeNull();
            if (!result) throw new Error("Expected an aligned region");
            expect(normalizedRegionToPixels(result.region, sourceWidth, sourceHeight)).toEqual({
                x: cropX + 219,
                y: cropY + 100,
                width: 362,
                height: 311,
            });
            expect(result.replayFrames.map((frame) => [...frame.pixels.slice(0, 4)])).toEqual(
                frames.map((_, index) => [index + 10, index + 11, index + 12, 255]),
            );
        }
    });
}
it("does not combine observations across source dimension changes", () => {
    const localizer = new NormalLootLocalizer();
    const frame = searchFrame(219, 100, 100, 100);
    for (let i = 0; i < 4; i++) expect(localizer.pushFrame(frame)).toBeNull();
    const changed = { ...frame, sourceWidth: 1920, sourceHeight: 1080 };
    for (let i = 0; i < 5; i++) expect(localizer.pushFrame(changed)).toBeNull();
    expect(localizer.pushFrame(changed)).not.toBeNull();
});

it("keeps normal localization at four evaluations per second with a 16 FPS history", () => {
    const localizer = new NormalLootLocalizer(80, 16);
    const frame = searchFrame(219);
    for (let index = 0; index < 11; index++) expect(localizer.pushFrame(frame)).toBeNull();
    expect(localizer.evaluatedCandidateCount).toBe(2);
    expect(localizer.pushFrame(frame)?.replayFrames).toHaveLength(12);
    const empty = searchFrame(null);
    for (let index = 0; index < 40; index++) localizer.pushFrame(empty);
    expect(localizer.retainedFrameCount).toBe(24);
});
