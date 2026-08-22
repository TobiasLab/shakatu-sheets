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
    return { name, icon: `/items/${iconId}.webp`, valuation: "vendor", unitPrice };
}

const commonMarketDrops = {
    blackStone: market("Black Stone", 16_001),
    ancientSpiritDust: market("Ancient Spirit Dust", 721_002),
    caphrasStone: market("Caphras Stone", 721_003),
    sealedBlackMagicCrystal: market("Sealed Black Magic Crystal", 768_160),
    corruptOil: market("Corrupt Oil of Immortality", 1_178),
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

export const grindSpots = [sycraiaLower, starsEnd];

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
