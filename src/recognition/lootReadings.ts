import { grindSpots, supplementalDrops } from "../data/grindSpots";

/** An item name as recognition compares it: lowercase ASCII letters and digits only. */
export function normalizeItem(value: string) {
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

const quantitySuffix = /^(.*?)x\s*(?:\d+|[|Il])\s*[.,:;!?"'“”‘’–—-]*\s*$/i;

export function parseLootItem(text: string, dictionary: readonly string[], ignoredItems: readonly string[] = []) {
    const reading = text.match(quantitySuffix)?.[1];
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
    // An ignored item counts as known too, so its reading is never taken for a similar dictionary item.
    const dictionaryItems = new Set(dictionary.map(normalizeItem));
    const closerElsewhere = otherKnownItems(ignoredItems).some((item) => {
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

// Recognition passes the same list arrays until the user edits them, so one cached entry keyed on their identity
// keeps this work off the per-reading path.
let otherItemsCache: { ignoredItems: readonly string[]; items: string[] } | undefined;

/** Known loot plus the ignored items, normalized. */
function otherKnownItems(ignoredItems: readonly string[]) {
    if (ignoredItems.length === 0) return knownLootItems();
    if (otherItemsCache?.ignoredItems !== ignoredItems)
        otherItemsCache = { ignoredItems, items: [...knownLootItems(), ...ignoredItems.map(normalizeItem)] };
    return otherItemsCache.items;
}

let ignoreNamesCache:
    | {
          dictionary: readonly string[];
          ignoredItems: readonly string[];
          ignored: Map<string, string>;
          realItems: string[];
      }
    | undefined;

/** The normalized ignored items, and every other name a reading could be: the dictionary and all known loot. */
function ignoreNames(dictionary: readonly string[], ignoredItems: readonly string[]) {
    if (ignoreNamesCache?.dictionary !== dictionary || ignoreNamesCache.ignoredItems !== ignoredItems) {
        const ignored = new Map(ignoredItems.map((item) => [normalizeItem(item), item]));
        ignored.delete("");
        const realItems = [...new Set([...dictionary.map(normalizeItem), ...knownLootItems()])].filter(
            (item) => item && !ignored.has(item),
        );
        ignoreNamesCache = { dictionary, ignoredItems, ignored, realItems };
    }
    return ignoreNamesCache;
}

/** An ignored item must be at least this close; a reading of a real item vetoes ignoring when it is within reach. */
const IGNORED_ITEM_DISTANCE = 0.2;
const REAL_ITEM_DISTANCE = 0.35;

/** A reading without its quantity suffix or stray punctuation at either end, as a starting point for a name. */
export function lootItemText(text: string) {
    return (text.match(quantitySuffix)?.[1] ?? text.replace(/\s+x(?![a-z]).*$/i, ""))
        .replace(/^[^a-z0-9[(]+|[^a-z0-9)\]]+$/gi, "")
        .trim();
}

/** A reading's normalized item text, with and without anything that looks like a quantity suffix. */
function itemTexts(text: string) {
    return [
        ...new Set(
            [text, text.match(quantitySuffix)?.[1] ?? text, text.replace(/\s+x(?![a-z]).*$/i, "")]
                .map(normalizeItem)
                .filter(Boolean),
        ),
    ];
}

function nameDistance(texts: readonly string[], name: string, limit = 1) {
    let best = Number.POSITIVE_INFINITY;
    for (const text of texts) {
        const longest = Math.max(text.length, name.length);
        // Edit distance is at least the length difference, so most names are ruled out without computing it.
        if (Math.abs(text.length - name.length) / longest > limit) continue;
        best = Math.min(best, editDistance(text, name) / longest);
    }
    return best;
}

/**
 * The ignored item a drop's readings name, or null. Each reading belongs to the closest name among the ignored items,
 * the dictionary and every grind spot's loot. The drop is ignored only when at least two frames have a reading closest
 * to the same ignored item, and no reading of any frame is at least as close to a real item, so a misread real item
 * is never dropped silently. Readings need no quantity: some ignored items never show a readable one.
 */
function ignoredLootItem(
    rawReadings: readonly (readonly string[])[],
    dictionary: readonly string[],
    ignoredItems: readonly string[],
) {
    const { ignored, realItems } = ignoreNames(dictionary, ignoredItems);
    const frames = new Map<string, number>();
    for (const readings of rawReadings) {
        const named = new Set<string>();
        for (const text of readings) {
            const texts = itemTexts(text);
            let closest: { item: string | null; distance: number } = { item: null, distance: 1 };
            for (const [normalized, item] of ignored) {
                const distance = nameDistance(texts, normalized);
                if (distance < closest.distance) closest = { item, distance };
                else if (distance === closest.distance) closest = { item: null, distance };
            }
            const limit = Math.min(REAL_ITEM_DISTANCE, closest.distance);
            if (realItems.some((item) => nameDistance(texts, item, limit) <= limit)) return null;
            if (closest.item !== null && closest.distance <= IGNORED_ITEM_DISTANCE) named.add(closest.item);
        }
        for (const item of named) frames.set(item, (frames.get(item) ?? 0) + 1);
    }
    const supported = [...frames].filter(([, count]) => count >= 2);
    return supported.length === 1 && frames.size === 1 ? supported[0][0] : null;
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

export function analyzeLootReadings(
    rawReadings: readonly (readonly string[])[],
    dictionary: readonly string[],
    ignoredItems: readonly string[] = [],
) {
    const parsed = rawReadings.map((frameReadings) =>
        frameReadings.map((text) => ({
            item: parseLootItem(text, dictionary, ignoredItems),
            quantity: parseLootQuantity(text),
        })),
    );
    const consensus = chooseTemporalPairConsensus(parsed);
    // Every reading of every frame names the consensus pair, so no reading argues against it.
    const unanimous =
        consensus !== null &&
        parsed.every(
            (frameReadings) =>
                frameReadings.length > 0 &&
                frameReadings.every(({ item, quantity }) => item === consensus.item && quantity === consensus.quantity),
        );
    if (consensus) return { consensus, reason: null as null, conflicting: false, unanimous, ignored: null };
    // Two frames confidently reading different pairs veto every consensus, and more frames cannot lift that veto.
    const conflicting = confidentLootPairs(parsed).size > 1;
    const readings = parsed.flat();
    const ignored =
        ignoredItems.length > 0 && !readings.some(({ item }) => item !== null)
            ? ignoredLootItem(rawReadings, dictionary, ignoredItems)
            : null;
    if (!readings.some(({ quantity }) => quantity !== null)) {
        return { consensus: null, reason: "quantity-not-recognized" as const, conflicting, unanimous: false, ignored };
    }
    if (!readings.some(({ item }) => item !== null)) {
        return { consensus: null, reason: "item-not-recognized" as const, conflicting, unanimous: false, ignored };
    }
    return { consensus: null, reason: "consensus-withheld" as const, conflicting, unanimous: false, ignored };
}
