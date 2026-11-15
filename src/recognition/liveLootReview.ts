import type { LiveLootRecognitionResult } from "./liveLoot";
import type { LootFont } from "./lootFont";
import { analyzeLootReadings, lootItemText } from "./lootReadings";
import type { LearningProfile } from "./quantityLearning";

// History limit only: unresolved item captures remain available for the entire session.
export const maximumLiveLootReviewResults = 50;

export type LiveLootReviewEntry = {
    id: number;
    source: "normal" | "rare";
    font?: LootFont;
    learningProfile?: LearningProfile;
    learningId?: string;
    learningContext?: { sessionId: string; generation: number };
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

function savedReadings(entry: LiveLootReviewEntry) {
    return entry.result.status === "dropped"
        ? []
        : (entry.result.capture?.ocrFrames?.map((frame) => frame.readings) ?? []);
}

/** Whether live recognition with these lists would ignore an unresolved entry, judged by its saved readings. */
export function namesIgnoredItem(
    entry: LiveLootReviewEntry,
    ignoredItems: readonly string[],
    dictionary: readonly string[],
) {
    if (entry.accepted || entry.result.status !== "withheld") return false;
    return analyzeLootReadings(savedReadings(entry), dictionary, ignoredItems).ignored !== null;
}

/** The item text read most often in an entry's saved readings, to start an item name from. */
export function readItemName(entry: LiveLootReviewEntry) {
    const counts = new Map<string, number>();
    for (const text of savedReadings(entry).flat()) {
        const name = lootItemText(text);
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
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
