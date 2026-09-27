import { useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "shakatu-sheets-theme-v2";
const LEGACY_THEME_STORAGE_KEY = "shakatu-sheets-theme";

function readSavedTheme(): Theme {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) ?? localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    // The retired moss theme falls back to dark.
    return savedTheme === "light" ? "light" : "dark";
}

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(readSavedTheme);

    useLayoutEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    }, [theme]);

    return { theme, setTheme };
}
