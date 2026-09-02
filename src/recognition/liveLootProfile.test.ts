import { describe, expect, it } from "vitest";
import { parseLiveLootProfileArtifact, validateLiveLootProfileArtifact } from "./liveLootProfile";

function artifact(sourceWidth = 3440, sourceHeight = 1440, uiScalePercent: 80 | 100 = 80) {
    const size = uiScalePercent === 80 ? { width: 362, height: 311 } : { width: 453, height: 389 };
    return {
        version: 1,
        capture: { sourceWidth, sourceHeight, uiScalePercent, sampleFps: 8 },
        profile: {
            ...size,
            maxRows: 5,
            bottomCenter: size.height - 20,
            spacing: 40,
            rowThreshold: 100,
        },
    };
}

describe("live-loot profile artifacts", () => {
    it("parses every supported source and UI-scale pair", () => {
        for (const [sourceWidth, sourceHeight] of [
            [3440, 1440],
            [2560, 1440],
            [1920, 1080],
        ]) {
            for (const uiScalePercent of [80, 100] as const) {
                const value = artifact(sourceWidth, sourceHeight, uiScalePercent);
                expect(parseLiveLootProfileArtifact(JSON.stringify(value))).toEqual(value);
            }
        }
    });

    it("rejects unsupported capture metadata and mismatched crop dimensions", () => {
        expect(() => validateLiveLootProfileArtifact(artifact(1280, 720))).toThrow(/not supported/);
        expect(() => validateLiveLootProfileArtifact({ ...artifact(), version: 2 })).toThrow(/version/);
        expect(() =>
            validateLiveLootProfileArtifact({
                ...artifact(),
                capture: { ...artifact().capture, uiScalePercent: 90 },
            }),
        ).toThrow(/80 or 100/);
        expect(() =>
            validateLiveLootProfileArtifact({ ...artifact(), capture: { ...artifact().capture, sampleFps: 10 } }),
        ).toThrow(/exactly 8/);
        expect(() =>
            validateLiveLootProfileArtifact({ ...artifact(), profile: { ...artifact().profile, width: 453 } }),
        ).toThrow(/dimensions/);
    });

    it("rejects unsafe, nonpositive, and out-of-bounds geometry", () => {
        expect(() =>
            validateLiveLootProfileArtifact({
                ...artifact(),
                capture: { ...artifact().capture, sourceWidth: Number.MAX_SAFE_INTEGER + 1 },
            }),
        ).toThrow(/safe integer/);
        expect(
            validateLiveLootProfileArtifact({ ...artifact(), profile: { ...artifact().profile, rowThreshold: 0 } })
                .profile.rowThreshold,
        ).toBe(0);
        expect(() =>
            validateLiveLootProfileArtifact({ ...artifact(), profile: { ...artifact().profile, rowThreshold: -1 } }),
        ).toThrow(/non-negative safe integer/);
        expect(() =>
            validateLiveLootProfileArtifact({
                ...artifact(),
                profile: { ...artifact().profile, bottomCenter: 171, spacing: 40 },
            }),
        ).toThrow(/topCenter/);
        expect(() =>
            validateLiveLootProfileArtifact({
                ...artifact(),
                profile: { ...artifact().profile, bottomCenter: 300 },
            }),
        ).toThrow(/bottomCenter/);
    });

    it("rejects missing and unknown keys at every artifact level", () => {
        const value = artifact();
        expect(() => validateLiveLootProfileArtifact({ ...value, label: "private" })).toThrow(/exactly/);
        expect(() =>
            validateLiveLootProfileArtifact({ ...value, capture: { ...value.capture, path: "/recording.mp4" } }),
        ).toThrow(/exactly/);
        expect(() => validateLiveLootProfileArtifact({ ...value, profile: { ...value.profile, metric: 1 } })).toThrow(
            /exactly/,
        );
        const { profile: _profile, ...missing } = value;
        expect(() => validateLiveLootProfileArtifact(missing)).toThrow(/exactly/);
        expect(() => parseLiveLootProfileArtifact("not json")).toThrow(/valid JSON/);
    });
});
