import { isSupportedLootSource, LEGACY_LOOT_REGION_SIZES, type LootUiScale, lootRegionSize } from "./displayCapture";
import type { LootDetectionProfile } from "./liveLoot";

export type LiveLootProfileArtifactV1 = {
    version: 1;
    capture: {
        sourceWidth: number;
        sourceHeight: number;
        uiScalePercent: LootUiScale;
        sampleFps: 8;
    };
    profile: LootDetectionProfile;
};

function exactObject(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be an object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
        throw new Error(`${name} must contain exactly: ${fields.join(", ")}.`);
    }
    return value as Record<string, unknown>;
}

function positiveSafeInteger(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return value as number;
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${name} must be a non-negative safe integer.`);
    }
    return value as number;
}

export function validateLootDetectionProfile(value: unknown): LootDetectionProfile {
    const profile = exactObject(
        value,
        [
            "width",
            "height",
            "maxRows",
            "bottomCenter",
            "spacing",
            "rowThreshold",
            ...(typeof value === "object" && value !== null && "pixelScale" in value ? ["pixelScale"] : []),
        ],
        "profile",
    );
    if (profile.pixelScale !== undefined && profile.pixelScale !== 1 && profile.pixelScale !== 1.25) {
        throw new Error("profile.pixelScale must be 1 or 1.25.");
    }
    const validated: LootDetectionProfile = {
        width: positiveSafeInteger(profile.width, "profile.width"),
        height: positiveSafeInteger(profile.height, "profile.height"),
        maxRows: positiveSafeInteger(profile.maxRows, "profile.maxRows"),
        bottomCenter: positiveSafeInteger(profile.bottomCenter, "profile.bottomCenter"),
        spacing: positiveSafeInteger(profile.spacing, "profile.spacing"),
        rowThreshold: nonNegativeSafeInteger(profile.rowThreshold, "profile.rowThreshold"),
        ...(profile.pixelScale === undefined ? {} : { pixelScale: profile.pixelScale }),
    };
    const topCenter = validated.bottomCenter - (validated.maxRows - 1) * validated.spacing;
    if (!Number.isSafeInteger(topCenter) || topCenter < 12 || validated.bottomCenter > validated.height - 12) {
        throw new Error("profile row geometry must keep topCenter >= 12 and bottomCenter <= height - 12.");
    }
    return validated;
}

export function validateLiveLootProfileArtifact(value: unknown): LiveLootProfileArtifactV1 {
    const artifact = exactObject(value, ["version", "capture", "profile"], "artifact");
    if (artifact.version !== 1) throw new Error("Unsupported live-loot profile artifact version.");

    const capture = exactObject(
        artifact.capture,
        ["sourceWidth", "sourceHeight", "uiScalePercent", "sampleFps"],
        "capture",
    );
    const sourceWidth = positiveSafeInteger(capture.sourceWidth, "capture.sourceWidth");
    const sourceHeight = positiveSafeInteger(capture.sourceHeight, "capture.sourceHeight");
    if (!isSupportedLootSource(sourceWidth, sourceHeight)) {
        throw new Error("capture source dimensions are not supported for live-loot recognition.");
    }
    if (capture.uiScalePercent !== 80 && capture.uiScalePercent !== 100) {
        throw new Error("capture.uiScalePercent must be 80 or 100.");
    }
    if (capture.sampleFps !== 8) throw new Error("capture.sampleFps must be exactly 8.");

    const profile = validateLootDetectionProfile(artifact.profile);
    const expectedSize = lootRegionSize(capture.uiScalePercent);
    const legacy = LEGACY_LOOT_REGION_SIZES[capture.uiScalePercent];
    if (
        (profile.width !== expectedSize.width || profile.height !== expectedSize.height) &&
        (profile.width !== legacy.width || profile.height !== legacy.height)
    ) {
        throw new Error(
            `profile dimensions must be ${expectedSize.width}x${expectedSize.height} for ${capture.uiScalePercent}% UI scale.`,
        );
    }

    return {
        version: 1,
        capture: {
            sourceWidth,
            sourceHeight,
            uiScalePercent: capture.uiScalePercent,
            sampleFps: 8,
        },
        profile,
    };
}

export function parseLiveLootProfileArtifact(serialized: string): LiveLootProfileArtifactV1 {
    if (typeof serialized !== "string") throw new Error("Live-loot profile artifact input must be JSON text.");
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    } catch {
        throw new Error("Live-loot profile artifact is not valid JSON.");
    }
    return validateLiveLootProfileArtifact(value);
}
