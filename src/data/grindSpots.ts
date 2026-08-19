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
        name: "Ancient Undersea Weapon Power Stone",
        valuation: "vendor" as const,
        unitPrice: 107_900,
    },
    drops: [
        { name: "Sycraia Shard", valuation: "market", unitPrice: null, marketItemId: 821_347 },
        { name: "Deboreka Ring", valuation: "market", unitPrice: null, marketItemId: 12_094 },
        { name: "Tungrad Ring", valuation: "market", unitPrice: null, marketItemId: 12_061 },
        { name: "Refined Origin of Hunger", valuation: "market", unitPrice: null, marketItemId: 767_337 },
        { name: "Black Stone", valuation: "market", unitPrice: null, marketItemId: 16_001 },
    ] satisfies DropTemplate[],
};
