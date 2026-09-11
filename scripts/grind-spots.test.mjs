import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getGrindSpotDrops, grindSpots } from "../src/data/grindSpots";

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
});
