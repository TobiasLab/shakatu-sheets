import { grindSpots } from "../../data/grindSpots";

export const SPOT_PREFERENCES_KEY = "shakatu-sheets-spot-preferences-v1";
export type SpotPreferences = { favorites: string[]; recent: string[] };
export type SpotFilter = "All" | "Favorites" | "Recent";
const spotIds = new Set(grindSpots.map((spot) => spot.id));

export function parseSpotPreferences(raw: string | null): SpotPreferences {
    try {
        const value = JSON.parse(raw ?? "null");
        const clean = (ids: unknown): string[] =>
            Array.isArray(ids)
                ? [...new Set(ids.filter((id): id is string => typeof id === "string" && spotIds.has(id)))]
                : [];
        return { favorites: clean(value?.favorites), recent: clean(value?.recent).slice(0, 8) };
    } catch {
        return { favorites: [], recent: [] };
    }
}

export function rememberSpot(preferences: SpotPreferences, id: string): SpotPreferences {
    return { ...preferences, recent: [id, ...preferences.recent.filter((recent) => recent !== id)].slice(0, 8) };
}

export function quickSpotIds(preferences: SpotPreferences): string[] {
    return [...new Set([...preferences.favorites, ...preferences.recent])].slice(0, 4);
}

function normalize(value: string): string {
    return value.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}\s]/gu, "");
}

export function filterSpots(preferences: SpotPreferences, filter: SpotFilter, query: string) {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    const ids = filter === "Favorites" ? preferences.favorites : preferences.recent;
    const spots =
        filter === "All"
            ? [...grindSpots].sort((a, b) => a.name.localeCompare(b.name, "en"))
            : ids.flatMap((id) => grindSpots.find((spot) => spot.id === id) ?? []);
    return spots.filter((spot) => words.every((word) => normalize(spot.name).includes(word)));
}
