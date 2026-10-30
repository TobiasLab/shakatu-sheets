import { invoke } from "@tauri-apps/api/core";
import { cleanSpotPreferences, type SpotPreferences } from "../components/GrindSpotPicker/preferences";

export type Theme = "light" | "dark";
export type TrendView = "net" | "pace";

// Until September 2026 the theme and spot favorites lived in browser storage. The first load without a SQLite value
// uses the old value, saves it there, and removes it from browser storage once that save succeeds.
const legacyThemeKeys = ["shakatu-sheets-theme-v2", "shakatu-sheets-theme"];
const legacySpotPreferencesKey = "shakatu-sheets-spot-preferences-v1";

function readLegacy(keys: string[]): string | null {
    try {
        for (const key of keys) {
            const value = localStorage.getItem(key);
            if (value !== null) return value;
        }
    } catch {
        // Browser storage can be unavailable; there is then nothing to move.
    }
    return null;
}

function removeLegacy(keys: string[]) {
    try {
        for (const key of keys) localStorage.removeItem(key);
    } catch {
        // The SQLite value takes precedence, so a leftover browser value is never read again.
    }
}

export async function loadTheme(): Promise<Theme> {
    const saved = await invoke<Theme | null>("load_theme");
    if (saved !== null) return saved;
    const legacy = readLegacy(legacyThemeKeys);
    if (legacy === null) return "dark";
    // The retired moss theme falls back to dark.
    const theme = legacy === "light" ? "light" : "dark";
    try {
        await saveTheme(theme);
        removeLegacy(legacyThemeKeys);
    } catch {
        // The browser value stays, so the next load retries the move.
    }
    return theme;
}

export function saveTheme(theme: Theme) {
    return invoke<void>("save_theme", { theme });
}

export async function loadTrendView(): Promise<TrendView> {
    const view = await invoke<unknown>("load_trend_view");
    if (view !== "net" && view !== "pace") throw new Error("Invalid saved graph view.");
    return view;
}

export function saveTrendView(view: TrendView) {
    return invoke<void>("save_trend_view", { view });
}

export async function loadSpotPreferences(): Promise<SpotPreferences> {
    const saved = await invoke<unknown>("load_spot_preferences");
    if (saved !== null) return cleanSpotPreferences(saved);
    const legacy = readLegacy([legacySpotPreferencesKey]);
    if (legacy === null) return cleanSpotPreferences(null);
    let value: unknown = null;
    try {
        value = JSON.parse(legacy);
    } catch {
        // Malformed old preferences are dropped.
    }
    const preferences = cleanSpotPreferences(value);
    try {
        await saveSpotPreferences(preferences);
        removeLegacy([legacySpotPreferencesKey]);
    } catch {
        // The browser value stays, so the next load retries the move.
    }
    return preferences;
}

export function saveSpotPreferences(preferences: SpotPreferences) {
    return invoke<void>("save_spot_preferences", { preferences });
}
