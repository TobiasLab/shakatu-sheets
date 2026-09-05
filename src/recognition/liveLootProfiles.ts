import type { LootUiScale } from "./displayCapture";
import { type LiveLootProfileArtifactV1, validateLiveLootProfileArtifact } from "./liveLootProfile";
import calibrated3440x1440At80 from "./profiles/live-loot-3440x1440-80.json";

import { RARE_LOOT_GEOMETRY } from "./rareLoot";

// Add only profiles evaluated against independent labeled recordings.
const calibratedProfiles = [
    { normal: validateLiveLootProfileArtifact(calibrated3440x1440At80), rare: RARE_LOOT_GEOMETRY },
];

export function findLiveLootProfile(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): LiveLootProfileArtifactV1 | null {
    return (
        calibratedProfiles.find(
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
    return (
        sourceWidth === 3440 &&
        sourceHeight === 1440 &&
        uiScalePercent === 80 &&
        findLiveLootProfile(sourceWidth, sourceHeight, uiScalePercent) !== null
    );
}

export function findRareLootGeometry(sourceWidth: number, sourceHeight: number, uiScalePercent: LootUiScale) {
    return (
        calibratedProfiles.find(
            ({ normal }) =>
                normal.capture.sourceWidth === sourceWidth &&
                normal.capture.sourceHeight === sourceHeight &&
                normal.capture.uiScalePercent === uiScalePercent,
        )?.rare ?? null
    );
}
