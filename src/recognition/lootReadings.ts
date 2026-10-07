import { grindSpots, supplementalDrops } from "../data/grindSpots";

function normalizeItem(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseLootQuantity(text: string) {
    const suffix = text.match(/x\s*(\d+|[|Il])\s*[.,:;!?"'“”‘’–—-]*\s*$/i)?.[1];
    if (!suffix) return null;
    if (/^[|Il]$/i.test(suffix)) return 1;
    const quantity = Number(suffix);
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function editDistance(left: string, right: string) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
            );
        }
        previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
}

export function parseLootItem(text: string, dictionary: readonly string[]) {
    const reading = text.match(/^(.*?)x\s*(?:\d+|[|Il])\s*[.,:;!?"'“”‘’–—-]*\s*$/i)?.[1];
    if (!reading) return null;
    const normalized = normalizeItem(reading);
    const joinedMarker = !/\s$/.test(reading);
    // A missing space needs a much closer dictionary match; an item's final "x" is not a quantity marker.
    if (joinedMarker && dictionary.some((item) => normalizeItem(item) === `${normalized}x`)) return null;
    const candidates = dictionary
        .map((item) => {
            const candidate = normalizeItem(item);
            return {
                item,
                distance: editDistance(normalized, candidate) / Math.max(normalized.length, candidate.length),
            };
        })
        .sort((left, right) => left.distance - right.distance);
    if (candidates[0]?.distance > (joinedMarker ? 0.1 : 0.35) || candidates[0]?.distance === candidates[1]?.distance)
        return null;
    const best = candidates[0];
    if (best.distance === 0) return best.item;
    // A clear reading of an item this spot cannot drop (for example "Deboreka Earring" at a spot that drops
    // "Deboreka Ring") must not become the similar dictionary item, so decline when another known item is closer.
    const dictionaryItems = new Set(dictionary.map(normalizeItem));
    const closerElsewhere = knownLootItems().some((item) => {
        const longest = Math.max(normalized.length, item.length);
        // Edit distance is at least the length difference, so most names are ruled out without computing it.
        if (dictionaryItems.has(item) || Math.abs(normalized.length - item.length) / longest >= best.distance)
            return false;
        return editDistance(normalized, item) / longest < best.distance;
    });
    return closerElsewhere ? null : best.item;
}

let knownItems: string[] | undefined;

/** Every loot name any grind spot can drop, normalized once. */
function knownLootItems() {
    knownItems ??= [
        ...new Set(
            [
                ...grindSpots.flatMap((spot) => [spot.trash, ...spot.drops].map((drop) => drop.name)),
                ...supplementalDrops.map((drop) => drop.name),
            ].map(normalizeItem),
        ),
    ];
    return knownItems;
}

type ParsedLootReading = { item: string | null; quantity: number | null };

function framePairs(readings: ParsedLootReading[]) {
    const unique = new Map<string, { count: number; item: string; quantity: number }>();
    for (const reading of readings) {
        if (reading.item === null || reading.quantity === null) continue;
        const key = `${reading.item}\0${reading.quantity}`;
        unique.set(key, {
            item: reading.item,
            quantity: reading.quantity,
            count: (unique.get(key)?.count ?? 0) + 1,
        });
    }
    return unique;
}

/** Item/quantity pairs that a majority of one frame's readings agree on. */
function confidentLootPairs(readingsByFrame: ParsedLootReading[][]) {
    const confident = new Set<string>();
    for (const readings of readingsByFrame) {
        for (const [key, reading] of framePairs(readings)) {
            if (reading.count > readings.length / 2) confident.add(key);
        }
    }
    return confident;
}

function chooseTemporalPairConsensus(readingsByFrame: ParsedLootReading[][]) {
    const counts = new Map<string, { count: number; item: string; quantity: number }>();
    const confidentPairs = confidentLootPairs(readingsByFrame);
    for (const readings of readingsByFrame) {
        for (const [key, reading] of framePairs(readings)) {
            const current = counts.get(key);
            counts.set(key, { ...reading, count: (current?.count ?? 0) + 1 });
        }
    }
    const ranked = [...counts.values()].sort((left, right) => right.count - left.count);
    const requiredSupport = Math.floor(readingsByFrame.length / 2) + 1;
    const winner = ranked[0];
    if (!winner || winner.count < requiredSupport || winner.count <= (ranked[1]?.count ?? 0)) return null;
    // Similar-looking adjacent rows can enter the same track. Do not outvote a frame that consistently reads
    // a different item or quantity, even when the other two frames agree.
    for (const key of confidentPairs) {
        if (key !== `${winner.item}\0${winner.quantity}`) return null;
    }
    return winner;
}

export function analyzeLootReadings(rawReadings: readonly (readonly string[])[], dictionary: readonly string[]) {
    const parsed = rawReadings.map((frameReadings) =>
        frameReadings.map((text) => ({
            item: parseLootItem(text, dictionary),
            quantity: parseLootQuantity(text),
        })),
    );
    const consensus = chooseTemporalPairConsensus(parsed);
    if (consensus) return { consensus, reason: null as null, conflicting: false };
    // Two frames confidently reading different pairs veto every consensus, and more frames cannot lift that veto.
    const conflicting = confidentLootPairs(parsed).size > 1;
    const readings = parsed.flat();
    if (!readings.some(({ quantity }) => quantity !== null)) {
        return { consensus: null, reason: "quantity-not-recognized" as const, conflicting };
    }
    if (!readings.some(({ item }) => item !== null)) {
        return { consensus: null, reason: "item-not-recognized" as const, conflicting };
    }
    return { consensus: null, reason: "consensus-withheld" as const, conflicting };
}
