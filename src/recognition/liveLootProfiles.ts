import { isSupportedLootSource, LOOT_CROP_BOUNDS, type LootUiScale } from "./displayCapture";
import { type LiveLootProfileArtifactV1, validateLiveLootProfileArtifact } from "./liveLootProfile";
import calibrated3440x1440At80 from "./profiles/live-loot-3440x1440-80.json";

import {
    COMPACT_RARE_LOOT_GEOMETRY,
    COMPACT_RARE_LOOT_GEOMETRY_100,
    RARE_LOOT_GEOMETRY,
    RARE_LOOT_GEOMETRY_100,
    type RareLootGeometry,
} from "./rareLoot";

// Both 1440p aspect ratios use the same crop-local geometry at a given UI scale.
const normal1440At80 = validateLiveLootProfileArtifact(calibrated3440x1440At80);
// Derived native geometry; genuine 100% gameplay calibration remains pending.
const normal1440At100 = validateLiveLootProfileArtifact({
    version: 1,
    capture: { ...normal1440At80.capture, uiScalePercent: 100 },
    profile: {
        width: 453,
        height: 389,
        maxRows: 5,
        bottomCenter: 255,
        spacing: 49,
        rowThreshold: 306,
        pixelScale: 1.25,
    },
});
const profiles = [
    { normal: normal1440At80, rare: COMPACT_RARE_LOOT_GEOMETRY },
    { normal: normal1440At100, rare: COMPACT_RARE_LOOT_GEOMETRY_100 },
].flatMap(({ normal, rare }) => {
    const bounds = LOOT_CROP_BOUNDS[normal.capture.uiScalePercent].normal;
    const compact = validateLiveLootProfileArtifact({
        ...normal,
        profile: {
            ...normal.profile,
            width: bounds.width,
            height: bounds.height,
            bottomCenter: normal.profile.bottomCenter - bounds.y,
        },
    });
    return [
        { normal: compact, rare },
        { normal: { ...compact, capture: { ...compact.capture, sourceWidth: 2560 } }, rare },
    ];
});

export function findLiveLootProfile(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
    legacy = false,
): LiveLootProfileArtifactV1 | null {
    const profile = profiles.find(
        ({ normal }) =>
            normal.capture.sourceWidth === sourceWidth &&
            normal.capture.sourceHeight === sourceHeight &&
            normal.capture.uiScalePercent === uiScalePercent,
    );
    if (!profile) return null;
    if (!legacy) return profile.normal;
    const original = uiScalePercent === 80 ? normal1440At80 : normal1440At100;
    return { ...original, capture: { ...original.capture, sourceWidth } };
}

export function supportsAutomaticLootLocalization(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): boolean {
    return (uiScalePercent === 80 || uiScalePercent === 100) && isSupportedLootSource(sourceWidth, sourceHeight);
}

export function findRareLootGeometry(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
    legacy = false,
): RareLootGeometry | null {
    const profile = profiles.find(
        ({ normal }) =>
            normal.capture.sourceWidth === sourceWidth &&
            normal.capture.sourceHeight === sourceHeight &&
            normal.capture.uiScalePercent === uiScalePercent,
    );
    if (!profile) return null;
    if (!legacy) return profile.rare;
    return uiScalePercent === 80 ? RARE_LOOT_GEOMETRY : RARE_LOOT_GEOMETRY_100;
}
