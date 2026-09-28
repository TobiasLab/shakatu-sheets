import { invoke } from "@tauri-apps/api/core";
import { cleanSpotPreferences, type SpotPreferences } from "../components/GrindSpotPicker/preferences";

export type Theme = "light" | "dark";

// Until September 2026 the theme and spot favorites lived in browser storage. The first load without a SQLite value
// saves the old value there and then removes it from browser storage.
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
    await saveTheme(theme);
    removeLegacy(legacyThemeKeys);
    return theme;
}

export function saveTheme(theme: Theme) {
    return invoke<void>("save_theme", { theme });
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
    await saveSpotPreferences(preferences);
    removeLegacy([legacySpotPreferencesKey]);
    return preferences;
}

export function saveSpotPreferences(preferences: SpotPreferences) {
    return invoke<void>("save_spot_preferences", { preferences });
}
