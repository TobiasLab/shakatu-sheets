import type { Valuation } from "../domain/session";

export type DropTemplate = {
    name: string;
    icon: string;
    valuation: Exclude<Valuation, "expense">;
    unitPrice: number | null;
    marketItemId?: number;
};

export const sycraiaLower = {
    name: "Sycraia Ruins Lower Level",
    trash: {
        name: "Underwater Ancient Weapon Power Stone",
        icon: "/items/56341.webp",
        valuation: "vendor" as const,
        unitPrice: 107_900,
    },
    drops: [
        {
            name: "Black Stone",
            icon: "/items/16001.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 16_001,
        },
        {
            name: "Ancient Spirit Dust",
            icon: "/items/721002.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 721_002,
        },
        {
            name: "Caphras Stone",
            icon: "/items/721003.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 721_003,
        },
        {
            name: "Sealed Black Magic Crystal",
            icon: "/items/768160.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 768_160,
        },
        {
            name: "Abyssal Essence",
            icon: "/items/9774.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 9_774,
        },
        {
            name: "Corrupt Oil of Immortality",
            icon: "/items/1178.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 1_178,
        },
        {
            name: "Violet Primordial Pigment - Edana",
            icon: "/items/767296.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_296,
        },
        {
            name: "Violet Primordial Luster - Edana",
            icon: "/items/821343.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_343,
        },
        {
            name: "Crimson Primordial Pigment - Sovereign",
            icon: "/items/767293.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_293,
        },
        {
            name: "Violet Primordial Pigment - Sovereign",
            icon: "/items/767294.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_294,
        },
        {
            name: "Crimson Primordial Luster - Sovereign",
            icon: "/items/821341.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_341,
        },
        {
            name: "Violet Primordial Luster - Sovereign",
            icon: "/items/821342.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_342,
        },
        {
            name: "Refined Essence of Devouring",
            icon: "/items/767338.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_338,
        },
        {
            name: "Refined Origin of Hunger",
            icon: "/items/767337.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 767_337,
        },
        { name: "Faint Sycraia's Memory", icon: "/items/56345.webp", valuation: "vendor", unitPrice: 150_000_000 },
        {
            name: "Gentle Sycraia's Memory",
            icon: "/items/56346.webp",
            valuation: "vendor",
            unitPrice: 300_000_000,
        },
        {
            name: "Intense Sycraia's Memory",
            icon: "/items/56347.webp",
            valuation: "vendor",
            unitPrice: 900_000_000,
        },
        {
            name: "Radiant Sycraia's Memory",
            icon: "/items/56348.webp",
            valuation: "vendor",
            unitPrice: 3_000_000_000,
        },
        {
            name: "Sycraia Shard",
            icon: "/items/821347.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 821_347,
        },
        {
            name: "Tungrad Ring",
            icon: "/items/12061.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 12_061,
        },
        { name: "PRI: Tungrad Ring", icon: "/items/12061.webp", valuation: "market", unitPrice: null },
        { name: "DUO: Tungrad Ring", icon: "/items/12061.webp", valuation: "market", unitPrice: null },
        {
            name: "Deboreka Ring",
            icon: "/items/12094.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 12_094,
        },
        { name: "PRI: Deboreka Ring", icon: "/items/12094.webp", valuation: "market", unitPrice: null },
        { name: "DUO: Deboreka Ring", icon: "/items/12094.webp", valuation: "market", unitPrice: null },
        { name: "TRI: Deboreka Ring", icon: "/items/12094.webp", valuation: "market", unitPrice: null },
        { name: "TET: Deboreka Ring", icon: "/items/12094.webp", valuation: "market", unitPrice: null },
        {
            name: "Traveler's Map",
            icon: "/items/16017.webp",
            valuation: "market",
            unitPrice: null,
            marketItemId: 16_017,
        },
        {
            name: "Sycraia Underwater Ruins Paint",
            icon: "/items/761718.webp",
            valuation: "vendor",
            unitPrice: 0,
        },
        { name: "Al Yurad's Ring Piece", icon: "/items/44271.webp", valuation: "vendor", unitPrice: 0 },
        { name: "Any Artifact", icon: "/items/artifact.png", valuation: "vendor", unitPrice: 16_200_000 },
    ] satisfies DropTemplate[],
};

export const sycraiaDrops: DropTemplate[] = [sycraiaLower.trash, ...sycraiaLower.drops];

export function getSycraiaDropIcon(name: string) {
    return sycraiaDrops.find((drop) => drop.name === name)?.icon;
}

export const sycraiaMarketItemIds = sycraiaLower.drops
    .map((drop) => drop.marketItemId)
    .filter((itemId): itemId is number => itemId !== undefined);
