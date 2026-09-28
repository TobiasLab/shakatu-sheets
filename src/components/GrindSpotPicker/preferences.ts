import { grindSpots } from "../../data/grindSpots";

export type SpotPreferences = { favorites: string[]; recent: string[] };
export type SpotFilter = "All" | "Favorites" | "Recent";
const spotIds = new Set(grindSpots.map((spot) => spot.id));

// Drops spot IDs that are unknown to this build, duplicated, or malformed.
export function cleanSpotPreferences(value: unknown): SpotPreferences {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const clean = (ids: unknown): string[] =>
        Array.isArray(ids)
            ? [...new Set(ids.filter((id): id is string => typeof id === "string" && spotIds.has(id)))]
            : [];
    return { favorites: clean(record.favorites), recent: clean(record.recent).slice(0, 8) };
}

export function rememberSpot(preferences: SpotPreferences, id: string): SpotPreferences {
    return { ...preferences, recent: [id, ...preferences.recent.filter((recent) => recent !== id)].slice(0, 8) };
}

export function quickSpotIds(preferences: SpotPreferences): string[] {
    return [...new Set([...preferences.favorites, ...preferences.recent])].slice(0, 4);
}

export function splitSpotName(name: string): { base: string; tag: string | null } {
    const match = /^\[([^\]]+)\]\s*(.+)$/.exec(name);
    return match ? { base: match[2], tag: match[1] } : { base: name, tag: null };
}

function compareSpotNames(first: string, second: string) {
    const a = splitSpotName(first);
    const b = splitSpotName(second);
    return a.base.localeCompare(b.base, "en") || (a.tag ?? "").localeCompare(b.tag ?? "", "en");
}

function normalize(value: string): string {
    return value.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}\s]/gu, "");
}

export function filterSpots(preferences: SpotPreferences, filter: SpotFilter, query: string) {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    const ids = filter === "Favorites" ? preferences.favorites : preferences.recent;
    const spots =
        filter === "All"
            ? [...grindSpots].sort((a, b) => compareSpotNames(a.name, b.name))
            : ids.flatMap((id) => grindSpots.find((spot) => spot.id === id) ?? []);
    return spots.filter((spot) => words.every((word) => normalize(spot.name).includes(word)));
}
