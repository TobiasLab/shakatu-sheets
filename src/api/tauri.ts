import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
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
    id: string;
    name: string;
    classId: number;
    spec: "awak" | "succ" | null;
};

export type GarmothSettings = {
    apiKeyConfigured: boolean;
    characterIds: string[];
    characters: GarmothCharacter[];
    selectedCharacterId: string | null;
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

export function selectGarmothCharacter(characterId: string) {
    return invoke<void>("select_garmoth_character", { characterId });
}

export function uploadGarmothSession(input: GarmothUploadInput) {
    return invoke<GarmothUploadResult>("upload_garmoth_session", { input });
}

export type NativeCaptureFrame = {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
};

export function supportsNativeDisplayCapture() {
    return isTauri() && navigator.userAgent.includes("Linux");
}

export function startNativeDisplayCapture(
    onFrame: (frame: NativeCaptureFrame) => void,
    onError: (message: string) => void,
) {
    const frames = new Channel<ArrayBuffer>((message) => {
        try {
            const bytes = new Uint8Array(message);
            if (bytes.byteLength < 16) {
                onError("Native display capture returned an invalid frame.");
                return;
            }
            const header = new DataView(message, 0, 16);
            const width = header.getUint32(0, true);
            if (width === 0) {
                onError(new TextDecoder().decode(bytes.subarray(16)));
                return;
            }
            const height = header.getUint32(4, true);
            const sourceWidth = header.getUint32(8, true);
            const sourceHeight = header.getUint32(12, true);
            if (
                height === 0 ||
                sourceWidth === 0 ||
                sourceHeight === 0 ||
                width > 640 ||
                height > 360 ||
                bytes.byteLength !== 16 + width * height * 4
            ) {
                onError("Native display capture returned an invalid frame.");
                return;
            }
            onFrame({ pixels: new Uint8ClampedArray(message, 16), width, height, sourceWidth, sourceHeight });
        } finally {
            void invoke("acknowledge_native_display_frame");
        }
    });
    return invoke<void>("start_native_display_capture", { frames });
}

export function stopNativeDisplayCapture() {
    return invoke<void>("stop_native_display_capture");
}
