import { invoke } from "@tauri-apps/api/core";
import { isLootFont, type LootFont } from "../recognition/lootFont";

export async function loadLootFont(): Promise<LootFont> {
    const font = await invoke<unknown>("load_loot_font");
    if (!isLootFont(font)) throw new Error("Invalid saved in-game font.");
    return font;
}

export function saveLootFont(font: LootFont) {
    return invoke<void>("save_loot_font", { font });
}
