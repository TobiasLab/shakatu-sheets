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

    it("shares native normal and rare geometry across every supported source", () => {
        for (const uiScale of [80, 100] as const) {
            const ultrawide = findLiveLootProfile(3440, 1440, uiScale);
            for (const [width, height] of [
                [2560, 1440],
                [1920, 1080],
            ]) {
                const profile = findLiveLootProfile(width, height, uiScale);
                expect(profile).toMatchObject({
                    capture: { sourceWidth: width, sourceHeight: height, uiScalePercent: uiScale, sampleFps: 8 },
                });
                expect(profile?.profile).toBe(ultrawide?.profile);
                expect(findLiveLootProfile(width, height, uiScale)).toBe(profile);
                expect(findRareLootGeometry(width, height, uiScale)).not.toBeNull();
                expect(findRareLootGeometry(width, height, uiScale)).toBe(findRareLootGeometry(3440, 1440, uiScale));
            }
        }
    });

    it("keeps the source dimensions on legacy profiles", () => {
        for (const [width, height] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            expect(findLiveLootProfile(width, height, 80, true)).toMatchObject({
                capture: { sourceWidth: width, sourceHeight: height, uiScalePercent: 80 },
                profile: { width: 362, height: 311 },
            });
            expect(findLiveLootProfile(width, height, 100, true)).toMatchObject({
                capture: { sourceWidth: width, sourceHeight: height, uiScalePercent: 100 },
                profile: { width: 453, height: 389 },
            });
            expect(findRareLootGeometry(width, height, 80, true)).toBe(findRareLootGeometry(3440, 1440, 80, true));
            expect(findRareLootGeometry(width, height, 100, true)).toBe(findRareLootGeometry(3440, 1440, 100, true));
        }
    });

    it("returns null for unsupported sources", () => {
        for (const [width, height] of [
            [1280, 720],
            [2561, 1440],
            [1920, 1200],
            [3840, 2160],
        ]) {
            for (const uiScale of [80, 100] as const) {
                expect(findLiveLootProfile(width, height, uiScale)).toBeNull();
                expect(findLiveLootProfile(width, height, uiScale, true)).toBeNull();
                expect(findRareLootGeometry(width, height, uiScale)).toBeNull();
                expect(findRareLootGeometry(width, height, uiScale, true)).toBeNull();
            }
        }
    });

    it("provides native 100% normal and rare geometry for every supported source", () => {
        for (const [width, height] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            expect(findLiveLootProfile(width, height, 100)).toMatchObject({
                capture: { sourceWidth: width, sourceHeight: height, uiScalePercent: 100 },
                profile: { width: 341, height: 226, bottomCenter: 211, spacing: 49, pixelScale: 1.25 },
            });
            expect(findRareLootGeometry(width, height, 100)).toMatchObject({ width: 425, height: 90 });
        }
    });
});

describe("localization availability", () => {
    it("allows automatic localization for every supported source", () => {
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
