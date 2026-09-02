import type { LootUiScale } from "./displayCapture";
import { type LiveLootProfileArtifactV1, validateLiveLootProfileArtifact } from "./liveLootProfile";
import calibrated3440x1440At80 from "./profiles/live-loot-3440x1440-80.json";

const calibratedProfiles = [validateLiveLootProfileArtifact(calibrated3440x1440At80)];

export function findLiveLootProfile(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): LiveLootProfileArtifactV1 | null {
    return (
        calibratedProfiles.find(
            (artifact) =>
                artifact.capture.sourceWidth === sourceWidth &&
                artifact.capture.sourceHeight === sourceHeight &&
                artifact.capture.uiScalePercent === uiScalePercent,
        ) ?? null
    );
}
