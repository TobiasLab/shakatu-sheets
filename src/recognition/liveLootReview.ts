import type { LiveLootRecognitionResult } from "./liveLoot";

export const maximumLiveLootReviewResults = 50;

export type LiveLootReviewEntry = {
    id: number;
    result: LiveLootRecognitionResult;
    accepted: boolean;
    error: string;
};

export function appendLiveLootReviewResult(
    current: readonly LiveLootReviewEntry[],
    entry: LiveLootReviewEntry,
    maximumResults = maximumLiveLootReviewResults,
) {
    if (!Number.isSafeInteger(maximumResults) || maximumResults < 1) {
        throw new Error("Maximum live-loot review results must be a positive safe integer.");
    }
    const results = [entry, ...current];
    let omittedCount = 0;
    while (results.length > maximumResults) {
        let removableIndex = -1;
        for (let index = results.length - 1; index >= 1; index -= 1) {
            if (results[index].accepted || results[index].result.status !== "recognized") {
                removableIndex = index;
                break;
            }
        }
        results.splice(removableIndex === -1 ? results.length - 1 : removableIndex, 1);
        omittedCount += 1;
    }
    return { results, omittedCount };
}
