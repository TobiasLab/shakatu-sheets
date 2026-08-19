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
