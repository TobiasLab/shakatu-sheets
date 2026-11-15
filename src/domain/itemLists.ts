import type { DropTemplate } from "../data/grindSpots";
import { normalizeItem } from "../recognition/lootReadings";

/** An item the user tracks at every grind spot, valued at a fixed price per unit like a vendor item. */
export type GeneralItem = { name: string; unitPrice: number };
export type ItemLists = { ignoredItems: string[]; generalItems: GeneralItem[] };

export const emptyItemLists: ItemLists = { ignoredItems: [], generalItems: [] };
const maximumListLength = 200;

/** Why `name` cannot join either list, or null. Rust checks the same rules again when saving. */
export function itemNameError(lists: ItemLists, name: string) {
    const key = normalizeItem(name.trim());
    if (!key || name.trim().length > 100) return "Enter an item name of 1–100 characters.";
    if (isIgnoredItem(lists, name)) return `${name.trim()} is already ignored.`;
    if (lists.generalItems.some((item) => normalizeItem(item.name) === key))
        return `${name.trim()} is already in your items.`;
    return null;
}

export const unitPriceError = "Enter a whole silver price of 0 or more.";

/** A whole silver price of 0 or more, with or without digit grouping, or null. */
export function parseUnitPrice(value: string) {
    // Plain digits with optional grouping commas only: Number() would also accept "1e6", "0x1F" or "0b11".
    const digits = value.trim().replace(/,/g, "");
    if (!/^\d+$/.test(digits)) return null;
    const price = Number(digits);
    return Number.isSafeInteger(price) ? price : null;
}

/** Whether `name` is already ignored, compared as recognition compares names. */
export function isIgnoredItem(lists: ItemLists, name: string) {
    const key = normalizeItem(name.trim());
    return lists.ignoredItems.some((item) => normalizeItem(item) === key);
}

export function addIgnoredItem(lists: ItemLists, name: string): ItemLists | string {
    const error = itemNameError(lists, name);
    if (error) return error;
    if (lists.ignoredItems.length >= maximumListLength) return `Ignore at most ${maximumListLength} items.`;
    return { ...lists, ignoredItems: [...lists.ignoredItems, name.trim()] };
}

export function addGeneralItem(lists: ItemLists, name: string, unitPrice: string): ItemLists | string {
    const error = itemNameError(lists, name);
    if (error) return error;
    const price = parseUnitPrice(unitPrice);
    if (price === null) return unitPriceError;
    if (lists.generalItems.length >= maximumListLength) return `Add at most ${maximumListLength} items.`;
    return { ...lists, generalItems: [...lists.generalItems, { name: name.trim(), unitPrice: price }] };
}

/**
 * The spot's drops followed by the general items it does not already drop. A spot drop wins over a general item of
 * the same name, because two dictionary names that read alike would tie and neither would be recognized.
 */
export function withGeneralItems(drops: DropTemplate[], generalItems: readonly GeneralItem[]): DropTemplate[] {
    const names = new Set(drops.map((drop) => normalizeItem(drop.name)));
    return [
        ...drops,
        ...generalItems
            .filter((item) => !names.has(normalizeItem(item.name)))
            .map((item) => ({
                name: item.name,
                icon: "",
                garmothKey: "",
                valuation: "vendor" as const,
                unitPrice: item.unitPrice,
            })),
    ];
}

/** The names live recognition reads: every drop except ignored ones, since the ignore list wins. */
export function recognitionDictionary(drops: readonly DropTemplate[], ignoredItems: readonly string[]) {
    const ignored = new Set(ignoredItems.map(normalizeItem));
    return drops.map((drop) => drop.name).filter((name) => !ignored.has(normalizeItem(name)));
}
