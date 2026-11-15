import { describe, expect, it } from "vitest";
import { getGrindSpotDrops } from "../data/grindSpots";
import {
    addGeneralItem,
    addIgnoredItem,
    emptyItemLists,
    isIgnoredItem,
    parseUnitPrice,
    recognitionDictionary,
    withGeneralItems,
} from "./itemLists";

describe("item lists", () => {
    it("adds trimmed names once across both lists", () => {
        const ignored = addIgnoredItem(emptyItemLists, "  Shakatu Merchants Trade Token ");
        expect(ignored).toEqual({ ignoredItems: ["Shakatu Merchants Trade Token"], generalItems: [] });
        if (typeof ignored === "string") throw new Error(ignored);
        expect(addIgnoredItem(ignored, "shakatu merchants trade token")).toMatch(/already ignored/);
        expect(addGeneralItem(ignored, "Shakatu Merchants Trade Token", "5")).toMatch(/already ignored/);
        expect(addIgnoredItem(ignored, " -- ")).toMatch(/1–100 characters/);
        expect(addGeneralItem(ignored, "Event Box", "")).toMatch(/whole silver price/);
        expect(addGeneralItem(ignored, "Event Box", "1.5")).toMatch(/whole silver price/);
        expect(addGeneralItem(ignored, "Event Box", "-1")).toMatch(/whole silver price/);
        expect(addGeneralItem(ignored, "Event Box", "2500000")).toEqual({
            ignoredItems: ["Shakatu Merchants Trade Token"],
            generalItems: [{ name: "Event Box", unitPrice: 2_500_000 }],
        });
    });

    it("parses unit prices and finds ignored names as recognition compares them", () => {
        expect(parseUnitPrice("2,500,000")).toBe(2_500_000);
        expect(parseUnitPrice(" 0 ")).toBe(0);
        for (const text of ["1e6", "0x1F", "0b11", "-5", "1.5", "", " ", "12 000"])
            expect(parseUnitPrice(text)).toBeNull();
        for (const invalid of ["", " ", "-1", "1.5", "abc", "9007199254740992"])
            expect(parseUnitPrice(invalid)).toBeNull();
        const lists = { ignoredItems: ["Shakatu Merchants Trade Token"], generalItems: [] };
        expect(isIgnoredItem(lists, " shakatu merchants trade-token ")).toBe(true);
        expect(isIgnoredItem(lists, "Shakatu Merchants Trade Coin")).toBe(false);
    });

    it("offers general items at every spot unless the spot already drops them", () => {
        const spotDrops = getGrindSpotDrops("sycraia-lower-revamp");
        const drops = withGeneralItems(spotDrops, [
            { name: "Event Box", unitPrice: 1_000 },
            { name: "black stone", unitPrice: 5 },
        ]);
        expect(drops).toHaveLength(spotDrops.length + 1);
        expect(drops[drops.length - 1]).toEqual({
            name: "Event Box",
            icon: "",
            garmothKey: "",
            valuation: "vendor",
            unitPrice: 1_000,
        });
        expect(drops.filter((drop) => drop.name.toLowerCase() === "black stone")).toEqual([
            spotDrops.find((drop) => drop.name === "Black Stone"),
        ]);
    });

    it("leaves ignored items out of the recognition dictionary", () => {
        const drops = withGeneralItems(getGrindSpotDrops("sycraia-lower-revamp"), [
            { name: "Event Box", unitPrice: 1 },
        ]);
        const dictionary = recognitionDictionary(drops, ["BLACK STONE", "Shakatu Merchants Trade Token"]);
        expect(dictionary).not.toContain("Black Stone");
        expect(dictionary).toContain("Event Box");
        expect(dictionary).toHaveLength(drops.length - 1);
    });
});
