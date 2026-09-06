import { describe, expect, it } from "vitest";
import { type LootUiScale, normalizedRegionToPixels, searchRegionAroundLootRegion } from "./displayCapture";
import {
    analyzeLootRoiFrame,
    LiveLootCoordinator,
    type LiveLootOcrFrame,
    type LiveLootRecognitionResult,
    type LootRoiFrame,
} from "./liveLoot";
import { type LootSearchFrame, NormalLootLocalizer } from "./liveLootLocalization";
import { validateLiveLootProfileArtifact } from "./liveLootProfile";
import { findLiveLootProfile, findRareLootGeometry } from "./liveLootProfiles";
import { RareLootFrameAnalyzer } from "./rareLoot";
import { RareLootLocalizer } from "./rareLootLocalization";

function blank(width: number, height: number): LootRoiFrame {
    return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

function paint(frame: LootRoiFrame, left: number, top: number, right: number, bottom: number, color: number[]) {
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) frame.pixels.set(color, (y * frame.width + x) * 4);
    }
}

// Synthetic native pixel layouts exercise geometry and plumbing, not gameplay accuracy.
function normalFrame(scale: LootUiScale, count: number) {
    const frame = scale === 80 ? blank(362, 311) : blank(453, 389);
    const centers = scale === 80 ? [48, 87, 126, 165, 204] : [60, 109, 158, 206, 255];
    const factor = scale / 80;
    for (const center of centers.slice(5 - count)) {
        for (let x = 100; x <= 275; x += 5) {
            paint(
                frame,
                Math.round(x * factor),
                center - Math.round(6 * factor),
                Math.round((x + 2) * factor),
                center + Math.round(6 * factor) + 1,
                [220, 220, 220, 255],
            );
        }
    }
    return frame;
}

function searchFrame(sourceWidth: number): LootSearchFrame {
    return { ...blank(800, 600), sourceWidth, sourceHeight: 1440, cropX: sourceWidth - 800, cropY: 840 };
}

function normalSearch(sourceWidth: number, scale: LootUiScale) {
    const frame = searchFrame(sourceWidth);
    const factor = scale / 80;
    const centers = scale === 80 ? [165, 204] : [206, 255];
    for (const center of centers) {
        paint(
            frame,
            220 + Math.round(-19 * factor),
            100 + center - Math.round(6 * factor),
            220 + Math.round(249 * factor),
            101 + center + Math.round(6 * factor),
            [220, 220, 220, 255],
        );
    }
    return frame;
}

function rareSearch(sourceWidth: number, scale: LootUiScale, x: number, y: number) {
    const frame = searchFrame(sourceWidth);
    // Independently specified scaled shell and border, including crop-edge placements.
    const shell = scale === 80 ? [65, 35, 370, 80] : [81, 44, 463, 100];
    const border = scale === 80 ? [120, 34, 320, 38] : [150, 43, 400, 48];
    for (const [left, top, right, bottom] of [shell, border]) {
        paint(frame, x + left, y + top, x + right, y + bottom, [180, 125, 35, 255]);
    }
    return frame;
}

for (const [scale, sampleFps] of [
    [80, 8],
    [80, 16],
    [100, 8],
    [100, 16],
] as const) {
    const frameStep = sampleFps / 8;
    describe(`${scale}% native UI geometry at ${sampleFps} FPS`, () => {
        it.each([2560, 3440])("detects all five rows and recognizes a new drop at %ix1440", async (width) => {
            const artifact = findLiveLootProfile(width, 1440, scale);
            if (!artifact) throw new Error("Missing profile");
            expect(validateLiveLootProfileArtifact(artifact)).toEqual(artifact);
            expect(analyzeLootRoiFrame(normalFrame(scale, 5), artifact.profile).count).toBe(5);
            const results: LiveLootRecognitionResult[] = [];
            const ocrFrames: LiveLootOcrFrame[] = [];
            const coordinator = new LiveLootCoordinator({
                sampleFps,
                profile: artifact.profile,
                dictionary: ["Branch of Abundance"],
                readText: async (frames) => {
                    ocrFrames.push(...frames);
                    return frames.map(() => ["Branch of Abundance x 10"]);
                },
                onResult: (result) => results.push(result),
            });
            coordinator.pushFrame(normalFrame(scale, 0));
            for (let i = 0; i < 8 * frameStep; i++) coordinator.pushFrame(normalFrame(scale, 1));
            await coordinator.finish();
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({ status: "recognized", itemName: "Branch of Abundance", quantity: 10 });
            expect(ocrFrames).toHaveLength(3);
            const padding = scale === 80 ? 12 : 15;
            for (const frame of ocrFrames) {
                expect(frame.roi.width).toBe(scale === 80 ? 362 : 453);
                expect(frame.bounds?.bottom).toBe(frame.observation.centerY + padding);
                expect(frame.bounds?.top).toBe(frame.observation.centerY - padding);
            }
        });

        it.each([2560, 3440])("automatically places normal and rare regions in %ix1440 source pixels", (width) => {
            const normal = new NormalLootLocalizer(scale, sampleFps);
            let located = null;
            const input = normalSearch(width, scale);
            for (let i = 0; i < 8 * frameStep && !located; i++) located = normal.pushFrame(input);
            if (!located) throw new Error("Normal stack did not localize");
            const pixels = normalizedRegionToPixels(located.region, width, 1440);
            expect(Math.abs(pixels.x - (input.cropX + 220))).toBeLessThanOrEqual(1);
            expect(Math.abs(pixels.y - (input.cropY + 100))).toBeLessThanOrEqual(1);
            expect([pixels.width, pixels.height]).toEqual(scale === 80 ? [362, 311] : [453, 389]);
            expect(located.replayFrames).toHaveLength(6 * frameStep);
            expect(located.replayFrames.every((f) => f.width === pixels.width && f.height === pixels.height)).toBe(
                true,
            );
            expect(() => searchRegionAroundLootRegion(located.region, width, 1440, "normal", scale)).not.toThrow();

            for (const [x, y] of [[0, 0], scale === 80 ? [400, 500] : [300, 475]]) {
                const rare = new RareLootLocalizer(scale, sampleFps);
                const banner = rareSearch(width, scale, x, y);
                for (let i = 0; i < 2 * frameStep; i++) expect(rare.pushFrame(banner)).toBeNull();
                const found = rare.pushFrame(banner);
                if (!found) throw new Error("Rare banner did not localize");
                expect(normalizedRegionToPixels(found.region, width, 1440)).toEqual({
                    x: banner.cropX + x,
                    y: banner.cropY + y,
                    width: scale === 80 ? 400 : 500,
                    height: scale === 80 ? 100 : 125,
                });
                expect(() => searchRegionAroundLootRegion(found.region, width, 1440, "rare", scale)).not.toThrow();
            }
        });

        it("requires rare entrance confirmation and rejects blank search frames", () => {
            const geometry = findRareLootGeometry(3440, 1440, scale);
            if (!geometry) throw new Error("Missing rare geometry");
            const analyzer = new RareLootFrameAnalyzer(geometry, sampleFps);
            const crop = blank(geometry.width, geometry.height);
            expect(analyzer.pushFrame(crop).count).toBe(0);
            const search = rareSearch(3440, scale, 0, 0);
            for (let y = 0; y < crop.height; y++) {
                crop.pixels.set(search.pixels.subarray(y * 800 * 4, (y * 800 + crop.width) * 4), y * crop.width * 4);
            }
            for (let i = 0; i < 4 * frameStep - 1; i++) expect(analyzer.pushFrame(crop).count).toBe(0);
            expect(analyzer.pushFrame(crop).count).toBe(1);
            const normal = new NormalLootLocalizer(scale, sampleFps);
            const rare = new RareLootLocalizer(scale, sampleFps);
            for (let i = 0; i < 20 * frameStep; i++) {
                expect(normal.pushFrame(searchFrame(3440))).toBeNull();
                expect(rare.pushFrame(searchFrame(3440))).toBeNull();
            }
            expect(normal.retainedFrameCount).toBe(12 * frameStep);
        });
    });
}
