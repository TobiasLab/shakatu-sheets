import type { Valuation } from "../domain/session";

export type DropTemplate = {
    name: string;
    valuation: Exclude<Valuation, "expense">;
    unitPrice: number | null;
    note?: string;
};

export const sycraiaLower = {
    id: "sycraia-lower-revamp",
    name: "Sycraia Ruins Lower Level",
    recommendedAp: 395,
    recommendedDp: 460,
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

export const initialCaptureProfile = {
    locale: "en",
    sourceWidth: 2560,
    sourceHeight: 1440,
    uiScale: 0.8,
    notificationRegion: null,
};
