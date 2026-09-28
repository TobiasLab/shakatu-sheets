import { describe, expect, it } from "vitest";
import { grindSpots } from "../../data/grindSpots";
import { cleanSpotPreferences, filterSpots, quickSpotIds, rememberSpot, splitSpotName } from "./preferences";

const ids = grindSpots.slice(0, 10).map((spot) => spot.id);

describe("spot preferences", () => {
    it("recovers from malformed values and removes unknown and duplicate IDs", () => {
        expect(cleanSpotPreferences("broken")).toEqual({ favorites: [], recent: [] });
        expect(cleanSpotPreferences(null)).toEqual({ favorites: [], recent: [] });
        expect(cleanSpotPreferences({ favorites: [ids[0], "missing", ids[0], 2], recent: ids })).toEqual({
            favorites: [ids[0]],
            recent: ids.slice(0, 8),
        });
        expect(cleanSpotPreferences({ favorites: {}, recent: false })).toEqual({ favorites: [], recent: [] });
    });
    it("prioritizes favorites and fills four shortcuts with distinct recent spots", () => {
        expect(quickSpotIds({ favorites: [ids[2], ids[0]], recent: [ids[0], ids[1], ids[2], ids[3], ids[4]] })).toEqual(
            [ids[2], ids[0], ids[1], ids[3]],
        );
        expect(quickSpotIds({ favorites: [], recent: [] })).toEqual([]);
    });
    it("moves repeated selections to the front and retains eight distinct recents", () => {
        const preferences = { favorites: [ids[2]], recent: ids.slice(0, 8) };
        expect(rememberSpot(preferences, ids[2])).toEqual({
            favorites: [ids[2]],
            recent: [ids[2], ids[0], ids[1], ...ids.slice(3, 8)],
        });
        expect(rememberSpot(preferences, ids[8]).recent).toEqual([ids[8], ...ids.slice(0, 7)]);
        expect(cleanSpotPreferences(preferences)).toEqual(preferences);
    });
});

describe("spot search", () => {
    const preferences = { favorites: [ids[2], ids[0]], recent: [ids[0], ids[2]] };
    it("ignores case and punctuation and matches query words in any order", () => {
        expect(filterSpots(preferences, "All", "END STAR’S").map((spot) => spot.id)).toContain("stars-end-revamp");
        const variants = filterSpots(preferences, "All", "forest ash dehkia");
        expect(variants.length).toBeGreaterThan(1);
        expect(filterSpots(preferences, "All", "forest ash [Dehkia 2]").map((spot) => spot.name)).toEqual([
            "[Dehkia 2] Ash Forest",
        ]);
    });
    it("keeps filter ordering, searches within the filter, and handles no matches", () => {
        expect(filterSpots(preferences, "Favorites", "").map((spot) => spot.id)).toEqual(preferences.favorites);
        expect(filterSpots(preferences, "Recent", "").map((spot) => spot.id)).toEqual(preferences.recent);
        expect(filterSpots(preferences, "Favorites", "sycraia").map((spot) => spot.id)).toEqual([ids[0]]);
        expect(filterSpots(preferences, "All", "no-such-spot")).toEqual([]);
        const bases = filterSpots(preferences, "All", "").map((spot) => splitSpotName(spot.name).base);
        expect(bases).toEqual([...bases].sort((a, b) => a.localeCompare(b, "en")));
    });
    it("groups region variants beside their base spot", () => {
        const names = filterSpots(preferences, "All", "ash forest").map((spot) => spot.name);
        expect(names).toEqual(["Ash Forest", "[Dehkia] Ash Forest", "[Dehkia 2] Ash Forest"]);
        expect(splitSpotName("[Dehkia 2] Ash Forest")).toEqual({ base: "Ash Forest", tag: "Dehkia 2" });
        expect(splitSpotName("Star's End")).toEqual({ base: "Star's End", tag: null });
    });
});
