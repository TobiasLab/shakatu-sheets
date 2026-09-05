import { isSupportedLootSource, type LootUiScale } from "./displayCapture";
import { type LiveLootProfileArtifactV1, validateLiveLootProfileArtifact } from "./liveLootProfile";
import calibrated3440x1440At80 from "./profiles/live-loot-3440x1440-80.json";

import { RARE_LOOT_GEOMETRY, RARE_LOOT_GEOMETRY_100 } from "./rareLoot";

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
    { normal: normal1440At80, rare: RARE_LOOT_GEOMETRY },
    { normal: normal1440At100, rare: RARE_LOOT_GEOMETRY_100 },
].flatMap(({ normal, rare }) => [
    { normal, rare },
    { normal: { ...normal, capture: { ...normal.capture, sourceWidth: 2560 } }, rare },
]);

export function findLiveLootProfile(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): LiveLootProfileArtifactV1 | null {
    return (
        profiles.find(
            (artifact) =>
                artifact.normal.capture.sourceWidth === sourceWidth &&
                artifact.normal.capture.sourceHeight === sourceHeight &&
                artifact.normal.capture.uiScalePercent === uiScalePercent,
        )?.normal ?? null
    );
}

export function supportsAutomaticLootLocalization(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): boolean {
    return (uiScalePercent === 80 || uiScalePercent === 100) && isSupportedLootSource(sourceWidth, sourceHeight);
}

export function findRareLootGeometry(sourceWidth: number, sourceHeight: number, uiScalePercent: LootUiScale) {
    return (
        profiles.find(
            ({ normal }) =>
                normal.capture.sourceWidth === sourceWidth &&
                normal.capture.sourceHeight === sourceHeight &&
                normal.capture.uiScalePercent === uiScalePercent,
        )?.rare ?? null
    );
}
