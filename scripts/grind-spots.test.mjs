import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDropIcon, getGrindSpotDrops, getMarketItemIds, grindSpots } from "../src/data/grindSpots";
import { parseLootItem } from "../src/recognition/liveLoot";

describe("bundled grind spots", () => {
    it("includes current grind spots and distinct Dehkia variants", () => {
        const names = grindSpots.map((spot) => spot.name);
        expect(names).toContain("Hystria Ruins");
        expect(names).toContain("[Dehkia] Hystria Ruins");
        expect(names).toContain("Orc Camp");
        expect(names.some((name) => /\(OLD\)|\(TBD\)/.test(name))).toBe(false);
        expect(new Set(grindSpots.map((spot) => spot.id)).size).toBe(grindSpots.length);
        expect(new Set(grindSpots.map((spot) => spot.garmothId)).size).toBe(grindSpots.length);
    });

    it("ships icons and unambiguous loot mappings for every added spot", () => {
        for (const spot of grindSpots.filter((spot) => spot.id.startsWith("garmoth-"))) {
            const drops = getGrindSpotDrops(spot.id);
            expect(spot.trash.valuation).toBe("vendor");
            expect(spot.trash.unitPrice).toBeGreaterThan(0);
            expect(new Set(drops.map((drop) => drop.name)).size).toBe(drops.length);
            for (const drop of drops) {
                expect(existsSync(`public${drop.icon}`), drop.icon).toBe(true);
                if (drop.marketItemId !== undefined) expect(drop.garmothKey).toBe(`${drop.marketItemId}_0`);
            }
        }
    });

    it("makes supplemental drops recognizable and priced at every spot without duplicate entries", () => {
        for (const spot of grindSpots) {
            const drops = getGrindSpotDrops(spot.id);
            const names = drops.map((drop) => drop.name);
            for (const name of ["Laila's Petal", "Pure Forest Breath", "[Event] Bountiful Autumn Lunchbox"]) {
                expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
                expect(parseLootItem(`${name} x 2`, names)).toBe(name);
                expect(existsSync(`public${getDropIcon(spot.id, name)}`)).toBe(true);
            }
            expect(getMarketItemIds(spot.id).filter((id) => id === 50807)).toEqual([50807]);
            expect(drops.find((drop) => drop.name === "Pure Forest Breath")).toMatchObject({
                valuation: "market",
                unitPrice: null,
                marketItemId: 50807,
            });
            expect(drops.find((drop) => drop.name === "Laila's Petal")).toMatchObject({
                valuation: "vendor",
                unitPrice: 500_000,
            });
            expect(drops.find((drop) => drop.name === "[Event] Bountiful Autumn Lunchbox")).toMatchObject({
                valuation: "vendor",
                unitPrice: 10_000_000,
            });
            for (const drop of [spot.trash, ...spot.drops]) {
                expect(drops.find((candidate) => candidate.garmothKey === drop.garmothKey)).toBe(drop);
            }
        }
    });
});
