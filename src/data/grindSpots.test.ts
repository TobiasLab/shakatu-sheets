import { describe, expect, it } from "vitest";
import { grindSpots } from "./grindSpots";

describe("grind spot profiles", () => {
    it("includes the supported profiles with their exact trash values", () => {
        expect(grindSpots.map(({ id, trash }) => [id, trash.name, trash.unitPrice])).toEqual([
            ["sycraia-lower-revamp", "Underwater Ancient Weapon Power Stone", 107_900],
            ["stars-end-revamp", "Corrupted Sanguine Crystal", 155_000],
            ["zephyros-castle", "Hardened Lava Chunk", 126_980],
            ["aphrodon-temple", "Branch of Abundance", 155_127],
            ["hermesia-inner-castle", "Black Crystal Fragment", 160_539],
            ["magaia-temple", "Elion Follower's Helmet", 181_042],
        ]);
    });
});
