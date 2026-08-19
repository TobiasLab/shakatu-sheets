import type { Valuation } from "../domain/session";

export type DropTemplate = {
    name: string;
    valuation: Exclude<Valuation, "expense">;
    unitPrice: number | null;
};

export const sycraiaLower = {
    name: "Sycraia Ruins Lower Level",
    trash: {
        name: "Ancient Undersea Weapon Power Stone",
        valuation: "vendor" as const,
        unitPrice: 107_900,
    },
    drops: [
        { name: "Sycraia's Fragment", valuation: "market", unitPrice: null },
        { name: "Deboreka Ring", valuation: "market", unitPrice: null },
        { name: "Tungrad Ring", valuation: "market", unitPrice: null },
        { name: "Refined Essence of Hunger", valuation: "market", unitPrice: null },
        { name: "Refined Origin of Hunger", valuation: "market", unitPrice: null },
        { name: "Black Stone", valuation: "market", unitPrice: null },
    ] satisfies DropTemplate[],
};
