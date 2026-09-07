import type { LiveLootRecognitionResult } from "./liveLoot";

// History limit only: unresolved item captures remain available for the entire session.
export const maximumLiveLootReviewResults = 50;

export type LiveLootReviewEntry = {
    id: number;
    source: "normal" | "rare";
    result: LiveLootRecognitionResult;
    accepted: boolean;
    error: string;
};

export function acceptLiveLootReviewEntry(
    entry: LiveLootReviewEntry,
    accept: (itemName: string, quantity: number) => string | null,
) {
    if (entry.accepted || entry.result.status !== "recognized") return entry;
    try {
        const error = accept(entry.result.itemName, entry.result.quantity);
        return { ...entry, accepted: error === null, error: error ?? "" };
    } catch (error) {
        return { ...entry, accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
}

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
            if (results[index].accepted || results[index].result.status === "dropped") {
                removableIndex = index;
                break;
            }
        }
        if (removableIndex === -1) break;
        results.splice(removableIndex, 1);
        omittedCount += 1;
    }
    return { results, omittedCount };
}

export function correctLiveLootReviewEntry(
    entry: LiveLootReviewEntry,
    itemName: string,
    quantity: number,
    accept: (itemName: string, quantity: number) => string | null,
): LiveLootReviewEntry {
    if (entry.accepted || entry.result.status === "dropped") return entry;
    if (!itemName.trim() || !Number.isSafeInteger(quantity) || quantity <= 0) {
        return { ...entry, error: "Choose an item and enter a positive whole-number quantity." };
    }
    try {
        const error = accept(itemName, quantity);
        return error === null
            ? { ...entry, accepted: true, error: "", result: { ...entry.result, capture: undefined } }
            : { ...entry, error };
    } catch (error) {
        return { ...entry, error: error instanceof Error ? error.message : String(error) };
    }
}
