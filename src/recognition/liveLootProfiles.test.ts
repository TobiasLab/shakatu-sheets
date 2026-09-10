import { describe, expect, it } from "vitest";
import { findLiveLootProfile, findRareLootGeometry, supportsAutomaticLootLocalization } from "./liveLootProfiles";

describe("findLiveLootProfile", () => {
    it("returns the held-out calibrated native 80% profile", () => {
        expect(findLiveLootProfile(3440, 1440, 80)).toMatchObject({
            version: 1,
            capture: { sourceWidth: 3440, sourceHeight: 1440, uiScalePercent: 80, sampleFps: 8 },
            profile: {
                width: 272,
                height: 180,
                maxRows: 5,
                bottomCenter: 168,
                spacing: 39,
                rowThreshold: 196,
            },
        });
    });

    it("shares native normal and rare geometry across the two 1440p aspect ratios", () => {
        const ultrawide = findLiveLootProfile(3440, 1440, 80);
        const widescreen = findLiveLootProfile(2560, 1440, 80);
        expect(widescreen).toMatchObject({
            capture: { sourceWidth: 2560, sourceHeight: 1440, uiScalePercent: 80, sampleFps: 8 },
        });
        expect(widescreen?.profile).toBe(ultrawide?.profile);
        expect(findLiveLootProfile(2560, 1440, 80)).toBe(widescreen);
        expect(findRareLootGeometry(2560, 1440, 80)).not.toBeNull();
        expect(findRareLootGeometry(2560, 1440, 80)).toBe(findRareLootGeometry(3440, 1440, 80));
        expect(findRareLootGeometry(1920, 1080, 80)).toBeNull();
    });

    it("provides native 100% normal and rare geometry for both 1440p widths", () => {
        for (const width of [2560, 3440]) {
            expect(findLiveLootProfile(width, 1440, 100)).toMatchObject({
                capture: { sourceWidth: width, uiScalePercent: 100 },
                profile: { width: 341, height: 226, bottomCenter: 211, spacing: 49, pixelScale: 1.25 },
            });
            expect(findRareLootGeometry(width, 1440, 100)).toMatchObject({ width: 425, height: 90 });
        }
        expect(findLiveLootProfile(1920, 1080, 80)).toBeNull();
        expect(findLiveLootProfile(1920, 1080, 100)).toBeNull();
    });
});

describe("localization availability", () => {
    it("allows automatic localization independently of OCR profile availability", () => {
        for (const [width, height] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            expect(supportsAutomaticLootLocalization(width, height, 80)).toBe(true);
        }
        expect(supportsAutomaticLootLocalization(2561, 1440, 80)).toBe(false);
        for (const [width, height, scale] of [
            [1920, 1080, 100],
            [2560, 1440, 100],
            [3440, 1440, 100],
        ] as const) {
            expect(supportsAutomaticLootLocalization(width, height, scale)).toBe(true);
        }
    });
});
