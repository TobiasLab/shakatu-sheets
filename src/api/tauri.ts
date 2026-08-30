import { invoke } from "@tauri-apps/api/core";
import type { SessionState } from "../domain/session";

export type MarketPriceSnapshot = {
    itemId: number;
    subId: number;
    basePrice: number;
    fetchedAt: number;
};

export type FinishedSessionRecord = {
    session: SessionState;
    finishedAt: number;
    garmothUploadStatus: "unknown" | "success" | null;
};

export type GarmothCharacter = {
    id: number;
    name: string;
    classId: number;
    spec: "awak" | "succ" | null;
};

export type GarmothSettings = {
    apiKeyConfigured: boolean;
    characterIds: number[];
    characters: GarmothCharacter[];
    selectedCharacterId: number | null;
};

export type GarmothUploadInput = {
    sessionId: string;
    grindspotId: number;
    minutes: number;
    hourly: number;
    total: number;
    drops: Record<string, number>;
    global: false;
};

export type GarmothUploadResult = {
    status: "success" | "unknown";
    message: string;
};

export function loadActiveSession() {
    return invoke<SessionState | null>("load_active_session");
}

export function saveSession(session: SessionState) {
    return invoke<void>("save_session", { session });
}

export function loadMarketPrices(region: SessionState["region"]) {
    return invoke<MarketPriceSnapshot[]>("load_market_prices", { region });
}

export function fetchMarketPrices(region: SessionState["region"], itemIds: number[]) {
    return invoke<MarketPriceSnapshot[]>("fetch_market_prices", { region, itemIds });
}

export function listFinishedSessions() {
    return invoke<FinishedSessionRecord[]>("list_finished_sessions");
}

export function reopenSession(id: string) {
    return invoke<SessionState>("reopen_session", { id });
}

export function loadGarmothSettings() {
    return invoke<GarmothSettings>("load_garmoth_settings");
}

export function saveGarmothApiKey(apiKey: string) {
    return invoke<void>("save_garmoth_api_key", { apiKey });
}

export function fetchGarmothCharacters(characterIds: string) {
    return invoke<GarmothCharacter[]>("fetch_garmoth_characters", { characterIds });
}

export function selectGarmothCharacter(characterId: number) {
    return invoke<void>("select_garmoth_character", { characterId });
}

export function uploadGarmothSession(input: GarmothUploadInput) {
    return invoke<GarmothUploadResult>("upload_garmoth_session", { input });
}
