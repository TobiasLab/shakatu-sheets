import { describe, expect, it } from "vitest";
import { getGrindSpotDrops, grindSpots } from "./grindSpots";

describe("grind spot profiles", () => {
    it("matches the supported Garmoth profiles", () => {
        expect(
            grindSpots.map(({ id, name, trash, drops }) => [id, name, trash.name, trash.unitPrice, drops.length]),
        ).toEqual([
            ["sycraia-lower-revamp", "Sycraia Ruins Lower Level", "Underwater Ancient Weapon Power Stone", 107_900, 20],
            ["stars-end-revamp", "Star's End", "Corrupted Sanguine Crystal", 155_000, 17],
            ["zephyros-castle", "Zephyrus Castle", "Hardened Lava Chunk", 126_980, 25],
            ["aphrodon-temple", "Aphrodon Temple", "Branch of Abundance", 155_127, 25],
            ["hermesia-inner-castle", "Hermesia Inner Castle", "Black Crystal Fragment", 160_539, 26],
            ["magaia-temple", "Magaia Temple", "Elion Follower's Helmet", 181_042, 28],
        ]);

        const dustDrops = grindSpots.flatMap(({ drops }) => drops).filter(({ name }) => name === "Ancient Spirit Dust");
        expect(dustDrops).toHaveLength(6);
        expect(dustDrops.every(({ valuation, unitPrice }) => valuation === "vendor" && unitPrice === 151_200)).toBe(
            true,
        );
    });

    it("maps every profile and drop to unique Garmoth identifiers", () => {
        const expected = [
            [
                "sycraia-lower-revamp",
                201,
                `56341_0 16001_0 721002_0 721003_0 768160_0 9774_0 56345_0 56346_0 56347_0 56348_0
                821347_0 12061_0 12061_1 12061_2 12094_0 12094_1 12094_2 16017_0 761718_0 44271_0
                100001004_0`,
            ],
            [
                "stars-end-revamp",
                200,
                `56339_0 16001_0 721002_0 721003_0 44405_0 768160_0 11853_0 11853_1 11853_2 11853_3
                11882_0 11882_1 11882_2 821344_0 15741_0 56340_0 100001008_0 100001007_0`,
            ],
            [
                "zephyros-castle",
                194,
                `767248_0 16001_0 721002_0 721003_0 768160_0 821317_0 821318_0 761802_0 761803_0 15291_0
                821320_0 821252_0 821250_0 821251_0 12276_0 12276_1 12276_2 11882_0 11882_1 11882_2
                12094_0 12094_1 12094_2 11653_0 11653_1 11653_2`,
            ],
            [
                "aphrodon-temple",
                213,
                `980127_0 767249_0 16001_0 721002_0 721003_0 1178_0 821460_0 821430_0 15294_0 821318_0 761803_0
                821422_0 11898_0 980139_0 821471_0 767337_0 767338_0 767353_0 821459_0 821341_0 767293_0
                821342_0 767294_0 767296_0 821343_0 821462_0`,
            ],
            [
                "hermesia-inner-castle",
                214,
                `980128_0 16001_0 721002_0 721003_0 1178_0 821460_0 821431_0 15295_0 11898_0 12144_0
                821422_0 821423_0 980140_0 821471_0 821318_0 761803_0 767337_0 767338_0 767353_0 821459_0
                767293_0 821341_0 821342_0 821343_0 767294_0 767296_0 821461_0`,
            ],
            [
                "magaia-temple",
                215,
                `980129_0 16001_0 721002_0 721003_0 1178_0 821460_0 821432_0 15296_0 821422_0 821423_0
                821424_0 11898_0 12144_0 12298_0 980141_0 821471_0 761803_0 821318_0 767337_0 767338_0
                821459_0 767353_0 821342_0 821343_0 767294_0 767296_0 821341_0 767293_0 821464_0`,
            ],
        ] as const;

        const actual = grindSpots.map((spot) => {
            const keys = getGrindSpotDrops(spot.id).map(({ garmothKey }) => garmothKey);
            expect(new Set(keys).size).toBe(keys.length);
            return [spot.id, spot.garmothId, keys];
        });

        expect(actual).toEqual(expected.map(([id, garmothId, keys]) => [id, garmothId, keys.trim().split(/\s+/)]));
    });
});

it("values the landscape frame as a vendor drop with the verified global export key", () => {
    expect(getGrindSpotDrops("aphrodon-temple").find(({ name }) => name === "Empty Picture Frame")).toEqual({
        name: "Empty Picture Frame",
        icon: "/items/767249.webp",
        garmothKey: "767249_0",
        valuation: "vendor",
        unitPrice: 15_348,
    });
});
