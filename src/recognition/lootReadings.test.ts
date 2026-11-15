import { describe, expect, it } from "vitest";
import { analyzeLootReadings, lootItemText, parseLootItem } from "./lootReadings";

const token = "Shakatu Merchants Trade Token";
const dictionary = ["Black Stone", "Ancient Spirit Dust", "Branch of Abundance"];

function analyze(readings: string[][], ignored: string[] = [token], items = dictionary) {
    return analyzeLootReadings(readings, items, ignored);
}

describe("ignored loot items", () => {
    it("ignores a drop whose readings never show a quantity once two frames name the item", () => {
        const analysis = analyze([
            ["Shakatu Merchants Trade Token", "Shakatu Merchants Trade Tokem", "| Shakatu Merchants Trade Token"],
            ["Shakatu Merchants Trade Token x", "Shakatu Merchant5 Trade Token", "Shakatu Merchants Trade To"],
        ]);
        expect(analysis).toMatchObject({ consensus: null, reason: "quantity-not-recognized", ignored: token });
    });

    it("ignores readings with a quantity suffix and a dictionary item put on the ignore list", () => {
        expect(analyze([[`${token} x 3`], [`${token} x3`]]).ignored).toBe(token);
        const withoutBlackStone = dictionary.filter((item) => item !== "Black Stone");
        expect(analyze([["Black Stone x 2"], ["Black Stonex2"]], ["Black Stone"], withoutBlackStone).ignored).toBe(
            "Black Stone",
        );
    });

    it("needs two frames that name the item", () => {
        expect(analyze([[token, token, token]]).ignored).toBeNull();
        expect(
            analyze([
                [token, token],
                ["noise", ""],
            ]).ignored,
        ).toBeNull();
        expect(analyze([[token], ["noise"], [token]]).ignored).toBe(token);
    });

    it("does not ignore names that are only similar", () => {
        for (const reading of ["Shakatu Merchants", "Merchants Trade Permit", "Shakatu Trade Box", "Trade Token"]) {
            expect(analyze([[reading], [reading]]).ignored).toBeNull();
        }
    });

    it("never ignores a reading of a real item", () => {
        // A real item read without its quantity stays in Needs attention.
        expect(analyze([["Black Stone"], ["Black Stone"]])).toMatchObject({
            reason: "quantity-not-recognized",
            ignored: null,
        });
        // An ignored name close to a real one loses every reading that is at least as close to the real item.
        expect(analyze([["Black Stone"], ["Black Stone x"]], ["Black Stones"]).ignored).toBeNull();
        expect(analyze([["Black Stone x 2"], ["Black Stone x 2"]], ["Black Stones"])).toMatchObject({
            consensus: { item: "Black Stone", quantity: 2 },
            ignored: null,
        });
        // Catalog items count even when this spot's dictionary lacks them.
        expect(analyze([["Caphras Stone"], ["Caphras Stone"]], ["Caphras Stones"]).ignored).toBeNull();
        // One frame that reads a real item vetoes the frames that read the ignored one.
        expect(analyze([[token], [token], ["Ancient Spirit Dust x 1"]]).ignored).toBeNull();
        expect(analyze([[token, "Ancient Spirit Dust"], [token]]).ignored).toBeNull();
    });

    it("does not choose between two ignored items", () => {
        const ignored = [token, "Shakatu Merchants Trade Coin"];
        expect(analyze([[token], [token]], ignored).ignored).toBe(token);
        expect(analyze([[token], ["Shakatu Merchants Trade Coin"]], ignored).ignored).toBeNull();
    });

    it("changes nothing without ignored items", () => {
        const readings = [[token], [token]];
        expect(analyze(readings, [])).toEqual(analyzeLootReadings(readings, dictionary));
        expect(analyze(readings, []).ignored).toBeNull();
    });

    it("keeps an ignored item from being read as a similar dictionary item", () => {
        const items = ["Shakatu Trade Token"];
        expect(parseLootItem(`${token} x 1`, items)).toBe("Shakatu Trade Token");
        expect(parseLootItem(`${token} x 1`, items, [token])).toBeNull();
        expect(parseLootItem("Shakatu Trade Token x 1", items, [token])).toBe("Shakatu Trade Token");
        expect(analyze([[`${token} x 1`], [`${token} x 1`]], [token], items)).toMatchObject({
            consensus: null,
            ignored: token,
        });
    });

    it("reads an item name from a reading for the ignore list", () => {
        expect(lootItemText("Shakatu Merchants Trade Token x 3")).toBe(token);
        expect(lootItemText("| Shakatu Merchants Trade Token x")).toBe(token);
        expect(lootItemText("Shakatu Merchants Trade Token.")).toBe(token);
        expect(lootItemText("[Event] Gift Box (7 days)")).toBe("[Event] Gift Box (7 days)");
    });
});
