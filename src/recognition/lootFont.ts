export type LootFont = "korean" | "strong-sword";

export function isLootFont(value: unknown): value is LootFont {
    return value === "korean" || value === "strong-sword";
}
