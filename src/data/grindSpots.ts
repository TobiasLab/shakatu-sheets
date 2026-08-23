import type { Valuation } from "../domain/session";

export type DropTemplate = {
    name: string;
    icon: string;
    valuation: Exclude<Valuation, "expense">;
    unitPrice: number | null;
    marketItemId?: number;
};

export type GrindSpotProfile = {
    id: string;
    name: string;
    trash: DropTemplate;
    drops: DropTemplate[];
};

function market(name: string, itemId: number): DropTemplate {
    return { name, icon: `/items/${itemId}.webp`, valuation: "market", unitPrice: null, marketItemId: itemId };
}

function enhancement(name: string, iconId: number): DropTemplate {
    return { name, icon: `/items/${iconId}.webp`, valuation: "market", unitPrice: null };
}

function vendor(name: string, iconId: number | string, unitPrice: number): DropTemplate {
    return {
        name,
        icon: `/items/${iconId}.${typeof iconId === "number" ? "webp" : "png"}`,
        valuation: "vendor",
        unitPrice,
    };
}

const commonMarketDrops = {
    blackStone: market("Black Stone", 16_001),
    ancientSpiritDust: market("Ancient Spirit Dust", 721_002),
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
    name: "Sycraia Ruins Lower Level",
    trash: vendor("Underwater Ancient Weapon Power Stone", 56_341, 107_900),
    drops: [
        commonMarketDrops.blackStone,
        commonMarketDrops.ancientSpiritDust,
        commonMarketDrops.caphrasStone,
        commonMarketDrops.sealedBlackMagicCrystal,
        market("Abyssal Essence", 9_774),
        commonMarketDrops.corruptOil,
        commonMarketDrops.violetPigmentEdana,
        commonMarketDrops.violetLusterEdana,
        commonMarketDrops.crimsonPigmentSovereign,
        commonMarketDrops.violetPigmentSovereign,
        commonMarketDrops.crimsonLusterSovereign,
        commonMarketDrops.violetLusterSovereign,
        commonMarketDrops.refinedEssence,
        commonMarketDrops.refinedOrigin,
        vendor("Faint Sycraia's Memory", 56_345, 150_000_000),
        vendor("Gentle Sycraia's Memory", 56_346, 300_000_000),
        vendor("Intense Sycraia's Memory", 56_347, 900_000_000),
        vendor("Radiant Sycraia's Memory", 56_348, 3_000_000_000),
        market("Sycraia Shard", 821_347),
        market("Tungrad Ring", 12_061),
        enhancement("PRI: Tungrad Ring", 12_061),
        enhancement("DUO: Tungrad Ring", 12_061),
        market("Deboreka Ring", 12_094),
        enhancement("PRI: Deboreka Ring", 12_094),
        enhancement("DUO: Deboreka Ring", 12_094),
        enhancement("TRI: Deboreka Ring", 12_094),
        enhancement("TET: Deboreka Ring", 12_094),
        market("Traveler's Map", 16_017),
        vendor("Sycraia Underwater Ruins Paint", 761_718, 0),
        vendor("Al Yurad's Ring Piece", 44_271, 0),
        vendor("Any Artifact", "artifact", 16_200_000),
    ],
};

export const starsEnd: GrindSpotProfile = {
    id: "stars-end-revamp",
    name: "Star's End",
    trash: vendor("Corrupted Sanguine Crystal", 56_339, 155_000),
    drops: [
        commonMarketDrops.blackStone,
        commonMarketDrops.ancientSpiritDust,
        commonMarketDrops.caphrasStone,
        commonMarketDrops.corruptOil,
        vendor("Clear Blackstar Crystal", 44_405, 100_000),
        commonMarketDrops.sealedBlackMagicCrystal,
        commonMarketDrops.refinedEssence,
        commonMarketDrops.refinedOrigin,
        market("Black Distortion Earring", 11_853),
        enhancement("PRI: Black Distortion Earring", 11_853),
        enhancement("DUO: Black Distortion Earring", 11_853),
        enhancement("TRI: Black Distortion Earring", 11_853),
        market("Deboreka Earring", 11_882),
        enhancement("PRI: Deboreka Earring", 11_882),
        enhancement("DUO: Deboreka Earring", 11_882),
        enhancement("TRI: Deboreka Earring", 11_882),
        enhancement("TET: Deboreka Earring", 11_882),
        market("Gluttony Crystal", 821_344),
        market("Corrupted Gluttony Crystal", 15_741),
        commonMarketDrops.violetPigmentEdana,
        commonMarketDrops.violetLusterSovereign,
        commonMarketDrops.violetLusterEdana,
        commonMarketDrops.violetPigmentSovereign,
        commonMarketDrops.crimsonLusterSovereign,
        commonMarketDrops.crimsonPigmentSovereign,
        vendor("Origin of Corruption", 56_340, 3_000_000_000),
    ],
};

export const zephyrosCastle: GrindSpotProfile = {
    id: "zephyros-castle",
    name: "Zephyros Castle",
    trash: vendor("Hardened Lava Chunk", 767_248, 126_980),
    drops: [
        commonMarketDrops.blackStone,
        commonMarketDrops.ancientSpiritDust,
        commonMarketDrops.caphrasStone,
        vendor("HAN Crystal of Ruin", 821_320, 10_000_000),
        vendor("HAN Crystal of Dusky Ruin", 15_291, 1_000_000_000),
        commonMarketDrops.silentFragment,
        commonMarketDrops.silentCrystal,
        market("Distorted Fragment of Origin", 821_317),
        market("Distorted Crystal of Origin", 761_802),
        market("Crystallized Energy of Endtimes", 821_252),
        market("Herald's Crystal", 821_250),
        market("Flawless Herald's Crystal", 821_251),
        market("Deboreka Ring", 12_094),
        enhancement("PRI: Deboreka Ring", 12_094),
        enhancement("DUO: Deboreka Ring", 12_094),
        enhancement("TRI: Deboreka Ring", 12_094),
        enhancement("TET: Deboreka Ring", 12_094),
        market("Deboreka Necklace", 11_653),
        enhancement("PRI: Deboreka Necklace", 11_653),
        enhancement("DUO: Deboreka Necklace", 11_653),
        enhancement("TRI: Deboreka Necklace", 11_653),
        enhancement("TET: Deboreka Necklace", 11_653),
        market("Deboreka Earring", 11_882),
        enhancement("PRI: Deboreka Earring", 11_882),
        enhancement("DUO: Deboreka Earring", 11_882),
        enhancement("TRI: Deboreka Earring", 11_882),
        enhancement("TET: Deboreka Earring", 11_882),
        market("Deboreka Belt", 12_276),
        enhancement("PRI: Deboreka Belt", 12_276),
        enhancement("DUO: Deboreka Belt", 12_276),
        enhancement("TRI: Deboreka Belt", 12_276),
        enhancement("TET: Deboreka Belt", 12_276),
        commonMarketDrops.violetPigmentEdana,
        commonMarketDrops.violetLusterEdana,
        commonMarketDrops.crimsonPigmentSovereign,
        commonMarketDrops.violetPigmentSovereign,
        commonMarketDrops.crimsonLusterSovereign,
        commonMarketDrops.violetLusterSovereign,
        commonMarketDrops.refinedEssence,
        commonMarketDrops.refinedOrigin,
        commonMarketDrops.corruptOil,
    ],
};

export const aphrodonTemple: GrindSpotProfile = {
    id: "aphrodon-temple",
    name: "Aphrodon Temple",
    trash: vendor("Branch of Abundance", 980_127, 155_127),
    drops: [
        vendor("WON Wandering Origin Crystal", 15_294, 1_200_000_000),
        vendor("WON Origin Shard", 821_430, 12_000_000),
        commonMarketDrops.silentFragment,
        commonMarketDrops.silentCrystal,
        vendor("Embers of Ynix - Armor", 821_462, 0),
        market("Twilight of the End - Earring", 821_422),
        market("Apeiron Earring", 11_898),
        commonMarketDrops.sunsetPigmentEdana,
        commonMarketDrops.sunsetLusterEdana,
        commonMarketDrops.corruptOil,
        vendor("Broken Vestige of Goldroot", 980_139, 3_000_000_000),
        commonMarketDrops.nevsFragment,
        commonMarketDrops.fusionShard,
    ],
};

export const hermesiaInnerCastle: GrindSpotProfile = {
    id: "hermesia-inner-castle",
    name: "Hermesia Inner Castle",
    trash: vendor("Black Crystal Fragment", 980_128, 160_539),
    drops: [
        vendor("BON Wandering Origin Crystal", 15_295, 1_500_000_000),
        vendor("BON Origin Shard", 821_431, 15_000_000),
        commonMarketDrops.silentFragment,
        commonMarketDrops.silentCrystal,
        vendor("Embers of Ynix - Helmet", 821_461, 0),
        market("Apeiron Earring", 11_898),
        market("Apeiron Ring", 12_144),
        market("Twilight of the End - Earring", 821_422),
        market("Twilight of the End - Ring", 821_423),
        commonMarketDrops.sunsetPigmentEdana,
        commonMarketDrops.sunsetLusterEdana,
        vendor("Broken Vestige of Ebonmere", 980_140, 3_100_000_000),
        commonMarketDrops.nevsFragment,
        commonMarketDrops.fusionShard,
        commonMarketDrops.corruptOil,
    ],
};

export const magaiaTemple: GrindSpotProfile = {
    id: "magaia-temple",
    name: "Magaia Temple",
    trash: vendor("Elion Follower's Helmet", 980_129, 181_042),
    drops: [
        vendor("Embers of Ynix - Shoes", 821_464, 0),
        market("Twilight of the End - Earring", 821_422),
        market("Twilight of the End - Ring", 821_423),
        market("Twilight of the End - Belt", 821_424),
        market("Apeiron Earring", 11_898),
        market("Apeiron Ring", 12_144),
        market("Apeiron Belt", 12_298),
        vendor("JIN Wandering Origin Crystal", 15_296, 1_700_000_000),
        vendor("JIN Origin Shard", 821_432, 17_000_000),
        vendor("Broken Vestige of Everlight", 980_141, 3_200_000_000),
        commonMarketDrops.nevsFragment,
        commonMarketDrops.fusionShard,
        commonMarketDrops.silentFragment,
        commonMarketDrops.silentCrystal,
        commonMarketDrops.corruptOil,
        commonMarketDrops.sunsetPigmentEdana,
        commonMarketDrops.sunsetLusterEdana,
    ],
};

export const grindSpots = [sycraiaLower, starsEnd, zephyrosCastle, aphrodonTemple, hermesiaInnerCastle, magaiaTemple];

export function getGrindSpot(id: string): GrindSpotProfile {
    return grindSpots.find((spot) => spot.id === id) ?? sycraiaLower;
}

export function getGrindSpotDrops(id: string): DropTemplate[] {
    const spot = getGrindSpot(id);
    return [spot.trash, ...spot.drops];
}

export function getDropIcon(grindSpotId: string, name: string): string | undefined {
    return getGrindSpotDrops(grindSpotId).find((drop) => drop.name === name)?.icon;
}

export function getMarketItemIds(grindSpotId: string): number[] {
    return getGrindSpot(grindSpotId)
        .drops.map((drop) => drop.marketItemId)
        .filter((itemId): itemId is number => itemId !== undefined);
}
