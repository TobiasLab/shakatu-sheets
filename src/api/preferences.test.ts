import { beforeEach, expect, it, vi } from "vitest";
import { grindSpots } from "../data/grindSpots";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { loadSpotPreferences, loadTheme } from "./preferences";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
});

beforeEach(() => {
    invoke.mockReset();
    storage.clear();
});

it("prefers the SQLite theme and ignores browser storage once it exists", async () => {
    storage.set("shakatu-sheets-theme-v2", "dark");
    invoke.mockResolvedValueOnce("light");
    await expect(loadTheme()).resolves.toBe("light");
    expect(invoke.mock.calls).toEqual([["load_theme"]]);
});

it("moves the browser theme into SQLite before removing it", async () => {
    storage.set("shakatu-sheets-theme", "light");
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    await expect(loadTheme()).resolves.toBe("light");
    expect(invoke.mock.calls[1]).toEqual(["save_theme", { theme: "light" }]);
    expect(storage.size).toBe(0);

    storage.set("shakatu-sheets-theme-v2", "moss");
    invoke.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("disk full"));
    await expect(loadTheme()).rejects.toThrow("disk full");
    expect(storage.get("shakatu-sheets-theme-v2")).toBe("moss");
});

it("moves cleaned browser spot favorites into SQLite", async () => {
    const [first, second] = grindSpots.map((spot) => spot.id);
    storage.set(
        "shakatu-sheets-spot-preferences-v1",
        JSON.stringify({ favorites: [first, "missing"], recent: [second] }),
    );
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    const expected = { favorites: [first], recent: [second] };
    await expect(loadSpotPreferences()).resolves.toEqual(expected);
    expect(invoke.mock.calls[1]).toEqual(["save_spot_preferences", { preferences: expected }]);
    expect(storage.size).toBe(0);

    invoke.mockResolvedValueOnce(null);
    await expect(loadSpotPreferences()).resolves.toEqual({ favorites: [], recent: [] });
    expect(invoke).toHaveBeenCalledTimes(3);
});
