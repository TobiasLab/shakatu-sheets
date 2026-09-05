import { isSupportedLootSource, type LootUiScale } from "./displayCapture";
import { type LiveLootProfileArtifactV1, validateLiveLootProfileArtifact } from "./liveLootProfile";
import calibrated3440x1440At80 from "./profiles/live-loot-3440x1440-80.json";

import { RARE_LOOT_GEOMETRY } from "./rareLoot";

// Both 1440p aspect ratios use the same native ROI geometry at 80% UI scale.
const normal1440At80 = validateLiveLootProfileArtifact(calibrated3440x1440At80);
const calibratedProfiles = [
    { normal: normal1440At80, rare: RARE_LOOT_GEOMETRY },
    {
        normal: {
            ...normal1440At80,
            capture: { ...normal1440At80.capture, sourceWidth: 2560 },
        },
        rare: RARE_LOOT_GEOMETRY,
    },
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
    return uiScalePercent === 80 && isSupportedLootSource(sourceWidth, sourceHeight);
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
