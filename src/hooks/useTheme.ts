import { useLayoutEffect, useState } from "react";

export type Theme = "light" | "moss" | "dark";

const THEME_STORAGE_KEY = "shakatu-sheets-theme-v2";
const LEGACY_THEME_STORAGE_KEY = "shakatu-sheets-theme";

function readSavedTheme(): Theme {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "moss" || savedTheme === "dark") return savedTheme;
    const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    return legacy === "light" ? "light" : legacy ? "moss" : "dark";
}

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(readSavedTheme);

    useLayoutEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    }, [theme]);

    return { theme, setTheme };
}
