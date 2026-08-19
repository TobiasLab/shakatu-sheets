import type { Valuation } from "../domain/session";

export type DropTemplate = {
    name: string;
    valuation: Exclude<Valuation, "expense">;
    unitPrice: number | null;
    marketItemId?: number;
};

export const sycraiaLower = {
    name: "Sycraia Ruins Lower Level",
    trash: {
        name: "Underwater Ancient Weapon Power Stone",
        valuation: "vendor" as const,
        unitPrice: 107_900,
    },
    drops: [
        { name: "Black Stone", valuation: "market", unitPrice: null, marketItemId: 16_001 },
        { name: "Ancient Spirit Dust", valuation: "market", unitPrice: null, marketItemId: 721_002 },
        { name: "Caphras Stone", valuation: "market", unitPrice: null, marketItemId: 721_003 },
        { name: "Sealed Black Magic Crystal", valuation: "market", unitPrice: null, marketItemId: 768_160 },
        { name: "Abyssal Essence", valuation: "market", unitPrice: null, marketItemId: 9_774 },
        { name: "Corrupt Oil of Immortality", valuation: "market", unitPrice: null, marketItemId: 1_178 },
        {
            name: "Violet Primordial Pigment - Edana",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_296,
        },
        {
            name: "Violet Primordial Luster - Edana",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_343,
        },
        {
            name: "Crimson Primordial Pigment - Sovereign",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_293,
        },
        {
            name: "Violet Primordial Pigment - Sovereign",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_294,
        },
        {
            name: "Crimson Primordial Luster - Sovereign",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_341,
        },
        {
            name: "Violet Primordial Luster - Sovereign",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_342,
        },
        { name: "Refined Essence of Devouring", valuation: "market", unitPrice: null, marketItemId: 767_338 },
        { name: "Refined Origin of Hunger", valuation: "market", unitPrice: null, marketItemId: 767_337 },
        { name: "Faint Sycraia's Memory", valuation: "vendor", unitPrice: 150_000_000 },
        { name: "Gentle Sycraia's Memory", valuation: "vendor", unitPrice: 300_000_000 },
        { name: "Intense Sycraia's Memory", valuation: "vendor", unitPrice: 900_000_000 },
        { name: "Radiant Sycraia's Memory", valuation: "vendor", unitPrice: 3_000_000_000 },
        { name: "Sycraia Shard", valuation: "market", unitPrice: null, marketItemId: 821_347 },
        { name: "Tungrad Ring", valuation: "market", unitPrice: null, marketItemId: 12_061 },
        { name: "PRI: Tungrad Ring", valuation: "market", unitPrice: null },
        { name: "DUO: Tungrad Ring", valuation: "market", unitPrice: null },
        { name: "Deboreka Ring", valuation: "market", unitPrice: null, marketItemId: 12_094 },
        { name: "PRI: Deboreka Ring", valuation: "market", unitPrice: null },
        { name: "DUO: Deboreka Ring", valuation: "market", unitPrice: null },
        { name: "TRI: Deboreka Ring", valuation: "market", unitPrice: null },
        { name: "TET: Deboreka Ring", valuation: "market", unitPrice: null },
        { name: "Traveler's Map", valuation: "market", unitPrice: null, marketItemId: 16_017 },
        { name: "Sycraia Underwater Ruins Paint", valuation: "vendor", unitPrice: 0 },
        { name: "Al Yurad's Ring Piece", valuation: "vendor", unitPrice: 0 },
        { name: "Any Artifact", valuation: "vendor", unitPrice: 16_200_000 },
    ] satisfies DropTemplate[],
};

export const sycraiaMarketItemIds = sycraiaLower.drops
    .map((drop) => drop.marketItemId)
    .filter((itemId): itemId is number => itemId !== undefined);
