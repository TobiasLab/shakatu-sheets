export type ConsumablePresetExport = {
    name: string;
    itemIds: number[];
};

export function parseConsumablePresetExport(text: string): ConsumablePresetExport {
    if (text.length > 16_384) throw new Error("Preset export is too large.");
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Paste a valid Garmoth preset export.");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Paste a valid Garmoth preset export.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim() || record.name.trim().length > 100) {
        throw new Error("Preset name must contain 1–100 characters.");
    }
    if (typeof record.export !== "string" || !record.export.trim()) {
        throw new Error("The preset export must contain consumable IDs.");
    }
    const parts = record.export.split(",").map((part) => part.trim());
    if (parts.length > 100) throw new Error("A preset can contain at most 100 consumables.");
    const itemIds = parts.map((part) => {
        const id = Number(part);
        if (!/^[0-9]+$/.test(part) || !Number.isSafeInteger(id) || id <= 0) {
            throw new Error("Consumable IDs must be positive whole numbers.");
        }
        return id;
    });
    if (new Set(itemIds).size !== itemIds.length) throw new Error("The preset contains duplicate consumable IDs.");
    return { name: record.name.trim(), itemIds };
}

export type ConsumablePresetItem = {
    itemId: number;
    name: string;
    quantity: number;
    unitPrice: number;
};

export type ConsumablePreset = {
    id: string;
    name: string;
    region: "eu" | "na";
    items: ConsumablePresetItem[];
};

export function validateConsumableItems(items: ConsumablePresetItem[]) {
    if (items.length === 0 || items.length > 100) throw new Error("Choose 1–100 consumables.");
    const ids = new Set<number>();
    let total = 0;
    for (const item of items) {
        if (!Number.isSafeInteger(item.itemId) || item.itemId <= 0 || ids.has(item.itemId))
            throw new Error("Consumable IDs must be unique positive whole numbers.");
        ids.add(item.itemId);
        if (!item.name.trim() || item.name.length > 100)
            throw new Error("Enter a name for each consumable (1–100 characters).");
        if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)
            throw new Error("Enter a positive whole quantity for each consumable.");
        if (!Number.isSafeInteger(item.unitPrice) || item.unitPrice < 0)
            throw new Error("Enter a whole silver unit price of 0 or more for each consumable.");
        total += item.quantity * item.unitPrice;
        if (!Number.isSafeInteger(total)) throw new Error("The consumable cost is too large.");
    }
    return total;
}
