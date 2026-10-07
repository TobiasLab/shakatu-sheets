import type { Valuation } from "../domain/session";
import importedSpots from "./garmothSpots.json";
import importedSupplementalDrops from "./supplementalDrops.json";

export type DropTemplate = {
    name: string;
    icon: string;
    garmothKey: string;
    valuation: Exclude<Valuation, "expense">;
    unitPrice: number | null;
    marketItemId?: number;
};

export type GrindSpotProfile = {
    id: string;
    garmothId: number;
    name: string;
    trash: DropTemplate;
    drops: DropTemplate[];
};

// Shared tracking items; membership here does not establish support for Garmoth uploads.
export const supplementalDrops = importedSupplementalDrops as DropTemplate[];

function market(name: string, itemId: number): DropTemplate {
    return {
        name,
        icon: `/items/${itemId}.webp`,
        garmothKey: `${itemId}_0`,
        valuation: "market",
        unitPrice: null,
        marketItemId: itemId,
    };
}

function enhancement(name: string, iconId: number, subKey: number): DropTemplate {
    return {
        name,
        icon: `/items/${iconId}.webp`,
        garmothKey: `${iconId}_${subKey}`,
        valuation: "market",
        unitPrice: null,
    };
}

function vendor(name: string, iconId: number | string, unitPrice: number, garmothMainKey = iconId): DropTemplate {
    return {
        name,
        icon: `/items/${iconId}.${typeof iconId === "number" ? "webp" : "png"}`,
        garmothKey: `${garmothMainKey}_0`,
        valuation: "vendor",
        unitPrice,
    };
}

const commonDrops = {
    blackStone: market("Black Stone", 16_001),
    ancientSpiritDust: vendor("Ancient Spirit Dust", 721_002, 151_200),
    caphrasStone: market("Caphras Stone", 721_003),
    sealedBlackMagicCrystal: market("Sealed Black Magic Crystal", 768_160),
    corruptOil: market("Corrupt Oil of Immortality", 1_178),
    silentFragment: market("Silent Fragment of Origin", 821_318),
    silentCrystal: market("Silent Crystal of Origin", 761_803),
    sunsetPigmentEdana: market("Sunset Primordial Pigment - Edana", 767_353),
    sunsetLusterEdana: market("Sunset Primordial Luster - Edana", 821_459),
    nevsFragment: market("Nev's Fragment", 821_460),
    fusionShard: market("Fusion Shard", 821_471),
    violetPigmentEdana: market("Violet Primordial Pigment - Edana", 767_296),
    violetLusterEdana: market("Violet Primordial Luster - Edana", 821_343),
    crimsonPigmentSovereign: market("Crimson Primordial Pigment - Sovereign", 767_293),
    violetPigmentSovereign: market("Violet Primordial Pigment - Sovereign", 767_294),
    crimsonLusterSovereign: market("Crimson Primordial Luster - Sovereign", 821_341),
    violetLusterSovereign: market("Violet Primordial Luster - Sovereign", 821_342),
    refinedEssence: market("Refined Essence of Devouring", 767_338),
    refinedOrigin: market("Refined Origin of Hunger", 767_337),
};

export const sycraiaLower: GrindSpotProfile = {
    id: "sycraia-lower-revamp",
    garmothId: 201,
    name: "Sycraia Ruins Lower Level",
    trash: vendor("Underwater Ancient Weapon Power Stone", 56_341, 107_900),
    drops: [
        commonDrops.blackStone,
        commonDrops.ancientSpiritDust,
        commonDrops.caphrasStone,
        commonDrops.sealedBlackMagicCrystal,
        market("Abyssal Essence", 9_774),
        vendor("Faint Sycraia's Memory", 56_345, 150_000_000),
        vendor("Gentle Sycraia's Memory", 56_346, 300_000_000),
        vendor("Intense Sycraia's Memory", 56_347, 900_000_000),
        vendor("Radiant Sycraia's Memory", 56_348, 3_000_000_000),
        market("Sycraia Shard", 821_347),
        market("Tungrad Ring", 12_061),
        enhancement("PRI: Tungrad Ring", 12_061, 1),
        enhancement("DUO: Tungrad Ring", 12_061, 2),
        market("Deboreka Ring", 12_094),
        enhancement("PRI: Deboreka Ring", 12_094, 1),
        enhancement("DUO: Deboreka Ring", 12_094, 2),
        market("Traveler's Map", 16_017),
        vendor("Sycraia Underwater Ruins Paint", 761_718, 0),
        vendor("Al Yurad's Ring Piece", 44_271, 0),
        vendor("Any Artifact", "artifact", 21_450_000, 100_001_004),
    ],
};

export const starsEnd: GrindSpotProfile = {
    id: "stars-end-revamp",
    garmothId: 200,
    name: "Star's End",
    trash: vendor("Corrupted Sanguine Crystal", 56_339, 155_000),
    drops: [
        commonDrops.blackStone,
        commonDrops.ancientSpiritDust,
        commonDrops.caphrasStone,
        vendor("Clear Blackstar Crystal", 44_405, 177_778_400),
        commonDrops.sealedBlackMagicCrystal,
        market("Black Distortion Earring", 11_853),
        enhancement("PRI: Black Distortion Earring", 11_853, 1),
        enhancement("DUO: Black Distortion Earring", 11_853, 2),
        enhancement("TRI: Black Distortion Earring", 11_853, 3),
        market("Deboreka Earring", 11_882),
        enhancement("PRI: Deboreka Earring", 11_882, 1),
        enhancement("DUO: Deboreka Earring", 11_882, 2),
        market("Gluttony Crystal", 821_344),
        market("Corrupted Gluttony Crystal", 15_741),
        vendor("Origin of Corruption", 56_340, 3_000_000_000),
        vendor("[EVENT] Apostle of Malevolence", 100_001_008, 0),
        vendor("[EVENT] Incarnation of Corruption", 100_001_007, 0),
    ],
};

export const zephyrosCastle: GrindSpotProfile = {
    id: "zephyros-castle",
    garmothId: 194,
    name: "Zephyrus Castle",
    trash: vendor("Hardened Lava Chunk", 767_248, 126_980),
    drops: [
        commonDrops.blackStone,
        commonDrops.ancientSpiritDust,
        commonDrops.caphrasStone,
        commonDrops.sealedBlackMagicCrystal,
        market("Distorted Fragment of Origin", 821_317),
        commonDrops.silentFragment,
        market("Distorted Crystal of Origin", 761_802),
        commonDrops.silentCrystal,
        vendor("HAN Crystal of Dusky Ruin", 15_291, 1_000_000_000),
        vendor("HAN Crystal of Ruin", 821_320, 10_000_000),
        market("Crystallized Energy of Endtimes", 821_252),
        market("Herald's Crystal", 821_250),
        market("Flawless Herald's Crystal", 821_251),
        market("Deboreka Belt", 12_276),
        enhancement("PRI: Deboreka Belt", 12_276, 1),
        enhancement("DUO: Deboreka Belt", 12_276, 2),
        market("Deboreka Earring", 11_882),
        enhancement("PRI: Deboreka Earring", 11_882, 1),
        enhancement("DUO: Deboreka Earring", 11_882, 2),
        market("Deboreka Ring", 12_094),
        enhancement("PRI: Deboreka Ring", 12_094, 1),
        enhancement("DUO: Deboreka Ring", 12_094, 2),
        market("Deboreka Necklace", 11_653),
        enhancement("PRI: Deboreka Necklace", 11_653, 1),
        enhancement("DUO: Deboreka Necklace", 11_653, 2),
    ],
};

export const aphrodonTemple: GrindSpotProfile = {
    id: "aphrodon-temple",
    garmothId: 213,
    name: "Aphrodon Temple",
    trash: vendor("Branch of Abundance", 980_127, 155_127),
    drops: [
        vendor("Empty Picture Frame", 767_249, 15_348),
        commonDrops.blackStone,
        commonDrops.ancientSpiritDust,
        commonDrops.caphrasStone,
        commonDrops.sealedBlackMagicCrystal,
        commonDrops.corruptOil,
        commonDrops.nevsFragment,
        vendor("WON Origin Shard", 821_430, 12_000_000),
        vendor("WON Wandering Origin Crystal", 15_294, 1_200_000_000),
        commonDrops.silentFragment,
        commonDrops.silentCrystal,
        market("Twilight of the End - Earring", 821_422),
        market("Apeiron Earring", 11_898),
        vendor("Broken Vestige of Goldroot", 980_139, 3_000_000_000),
        commonDrops.fusionShard,
        commonDrops.refinedOrigin,
        commonDrops.refinedEssence,
        commonDrops.sunsetPigmentEdana,
        commonDrops.sunsetLusterEdana,
        commonDrops.crimsonLusterSovereign,
        commonDrops.crimsonPigmentSovereign,
        commonDrops.violetLusterSovereign,
        commonDrops.violetPigmentSovereign,
        commonDrops.violetPigmentEdana,
        commonDrops.violetLusterEdana,
        vendor("Embers of Ynix - Armor", 821_462, 0),
    ],
};

export const hermesiaInnerCastle: GrindSpotProfile = {
    id: "hermesia-inner-castle",
    garmothId: 214,
    name: "Hermesia Inner Castle",
    trash: vendor("Black Crystal Fragment", 980_128, 160_539),
    drops: [
        commonDrops.blackStone,
        commonDrops.ancientSpiritDust,
        commonDrops.caphrasStone,
        commonDrops.corruptOil,
        commonDrops.nevsFragment,
        vendor("BON Origin Shard", 821_431, 15_000_000),
        vendor("BON Wandering Origin Crystal", 15_295, 1_500_000_000),
        market("Apeiron Earring", 11_898),
        market("Apeiron Ring", 12_144),
        market("Twilight of the End - Earring", 821_422),
        market("Twilight of the End - Ring", 821_423),
        vendor("Broken Vestige of Ebonmere", 980_140, 3_100_000_000),
        commonDrops.fusionShard,
        commonDrops.silentFragment,
        commonDrops.silentCrystal,
        commonDrops.refinedOrigin,
        commonDrops.refinedEssence,
        commonDrops.sunsetPigmentEdana,
        commonDrops.sunsetLusterEdana,
        commonDrops.crimsonPigmentSovereign,
        commonDrops.crimsonLusterSovereign,
        commonDrops.violetLusterSovereign,
        commonDrops.violetLusterEdana,
        commonDrops.violetPigmentSovereign,
        commonDrops.violetPigmentEdana,
        vendor("Embers of Ynix - Helmet", 821_461, 0),
    ],
};

export const magaiaTemple: GrindSpotProfile = {
    id: "magaia-temple",
    garmothId: 215,
    name: "Magaia Temple",
    trash: vendor("Elion Follower's Helmet", 980_129, 181_042),
    drops: [
        commonDrops.blackStone,
        commonDrops.ancientSpiritDust,
        commonDrops.caphrasStone,
        commonDrops.corruptOil,
        commonDrops.nevsFragment,
        vendor("JIN Origin Shard", 821_432, 17_000_000),
        vendor("JIN Wandering Origin Crystal", 15_296, 1_700_000_000),
        market("Twilight of the End - Earring", 821_422),
        market("Twilight of the End - Ring", 821_423),
        market("Twilight of the End - Belt", 821_424),
        market("Apeiron Earring", 11_898),
        market("Apeiron Ring", 12_144),
        market("Apeiron Belt", 12_298),
        vendor("Broken Vestige of Everlight", 980_141, 3_200_000_000),
        commonDrops.fusionShard,
        commonDrops.silentCrystal,
        commonDrops.silentFragment,
        commonDrops.refinedOrigin,
        commonDrops.refinedEssence,
        commonDrops.sunsetLusterEdana,
        commonDrops.sunsetPigmentEdana,
        commonDrops.violetLusterSovereign,
        commonDrops.violetLusterEdana,
        commonDrops.violetPigmentSovereign,
        commonDrops.violetPigmentEdana,
        commonDrops.crimsonLusterSovereign,
        commonDrops.crimsonPigmentSovereign,
        vendor("Embers of Ynix - Shoes", 821_464, 0),
    ],
};

export const grindSpots: GrindSpotProfile[] = [
    sycraiaLower,
    starsEnd,
    zephyrosCastle,
    aphrodonTemple,
    hermesiaInnerCastle,
    magaiaTemple,
    ...(importedSpots as GrindSpotProfile[]),
];

// Unknown IDs (spots no longer in the catalog) are shown as recorded.
export function grindSpotName(id: string) {
    return grindSpots.find((spot) => spot.id === id)?.name ?? id;
}

export function getGrindSpot(id: string): GrindSpotProfile {
    return grindSpots.find((spot) => spot.id === id) ?? sycraiaLower;
}

export function getGrindSpotDrops(id: string): DropTemplate[] {
    const spot = getGrindSpot(id);
    const drops = [spot.trash, ...spot.drops];
    const spotKeys = new Set(drops.map((drop) => drop.garmothKey));
    return [...drops, ...supplementalDrops.filter((drop) => !spotKeys.has(drop.garmothKey))];
}

export function getDropIcon(grindSpotId: string, name: string): string | undefined {
    return getGrindSpotDrops(grindSpotId).find((drop) => drop.name === name)?.icon;
}

export function getMarketItemIds(grindSpotId: string): number[] {
    return [
        ...new Set(
            getGrindSpotDrops(grindSpotId)
                .map((drop) => drop.marketItemId)
                .filter((itemId): itemId is number => itemId !== undefined),
        ),
    ];
}
