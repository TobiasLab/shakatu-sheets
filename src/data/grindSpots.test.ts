import { describe, expect, it } from "vitest";
import { grindSpots } from "./grindSpots";

describe("grind spot profiles", () => {
    it("matches the supported Garmoth profiles", () => {
        expect(
            grindSpots.map(({ id, name, trash, drops }) => [id, name, trash.name, trash.unitPrice, drops.length]),
        ).toEqual([
            ["sycraia-lower-revamp", "Sycraia Ruins Lower Level", "Underwater Ancient Weapon Power Stone", 107_900, 20],
            ["stars-end-revamp", "Star's End", "Corrupted Sanguine Crystal", 155_000, 17],
            ["zephyros-castle", "Zephyrus Castle", "Hardened Lava Chunk", 126_980, 25],
            ["aphrodon-temple", "Aphrodon Temple", "Branch of Abundance", 155_127, 24],
            ["hermesia-inner-castle", "Hermesia Inner Castle", "Black Crystal Fragment", 160_539, 26],
            ["magaia-temple", "Magaia Temple", "Elion Follower's Helmet", 181_042, 28],
        ]);

        const dustDrops = grindSpots.flatMap(({ drops }) => drops).filter(({ name }) => name === "Ancient Spirit Dust");
        expect(dustDrops).toHaveLength(6);
        expect(dustDrops.every(({ valuation, unitPrice }) => valuation === "vendor" && unitPrice === 151_200)).toBe(
            true,
        );
    });
});
