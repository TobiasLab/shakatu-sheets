import { describe, expect, it } from "vitest";
import { findLiveLootProfile } from "./liveLootProfiles";

describe("findLiveLootProfile", () => {
    it("returns the held-out calibrated native 80% profile", () => {
        expect(findLiveLootProfile(3440, 1440, 80)).toMatchObject({
            version: 1,
            capture: { sourceWidth: 3440, sourceHeight: 1440, uiScalePercent: 80, sampleFps: 8 },
            profile: {
                width: 362,
                height: 311,
                maxRows: 5,
                bottomCenter: 204,
                spacing: 39,
                rowThreshold: 196,
            },
        });
    });

    it("does not substitute a profile for uncalibrated capture combinations", () => {
        expect(findLiveLootProfile(3440, 1440, 100)).toBeNull();
        expect(findLiveLootProfile(2560, 1440, 80)).toBeNull();
        expect(findLiveLootProfile(1920, 1080, 80)).toBeNull();
    });
});
