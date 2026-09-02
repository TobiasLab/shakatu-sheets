import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { SessionState } from "../domain/session";
import {
    isSupportedLootSource,
    type LootUiScale,
    lootRegionSize,
    type NormalizedRegion,
    RARE_LOOT_REGION_SIZES,
} from "../recognition/displayCapture";

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
    kind: "preview" | "region" | "rare-region";
    captureId: number;
    batchId: number;
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
    cropX: number;
    cropY: number;
};

export type NativeCaptureError = { kind: "error"; message: string };

export type LootCaptureSettings = {
    region: NormalizedRegion;
    rareRegion?: NormalizedRegion | null;
    sourceWidth: number;
    sourceHeight: number;
    uiScalePercent: LootUiScale;
};

const NATIVE_FRAME_HEADER_BYTES = 40;
const NATIVE_FRAME_PROTOCOL_VERSION = 2;
export function parseNativeCaptureMessage(message: ArrayBuffer): NativeCaptureFrame | NativeCaptureError {
    const bytes = new Uint8Array(message);
    if (bytes.byteLength < NATIVE_FRAME_HEADER_BYTES) {
        throw new Error("Native display capture returned an invalid frame.");
    }
    const header = new DataView(message, 0, NATIVE_FRAME_HEADER_BYTES);
    const version = header.getUint32(0, true);
    const kind = header.getUint32(4, true);
    if (version !== NATIVE_FRAME_PROTOCOL_VERSION) {
        throw new Error("Native display capture returned an unsupported frame version.");
    }
    if (kind === 0) {
        return { kind: "error", message: new TextDecoder().decode(bytes.subarray(NATIVE_FRAME_HEADER_BYTES)) };
    }

    const captureId = header.getUint32(8, true);
    const batchId = header.getUint32(12, true);
    const width = header.getUint32(16, true);
    const height = header.getUint32(20, true);
    const sourceWidth = header.getUint32(24, true);
    const sourceHeight = header.getUint32(28, true);
    const cropX = header.getUint32(32, true);
    const cropY = header.getUint32(36, true);
    const validKind = kind === 1 || kind === 2 || kind === 3;
    const boundedPreview = kind !== 1 || (width <= 640 && height <= 360 && cropX === 0 && cropY === 0);
    const isNormalRegion = ([80, 100] as const).some((scale) => {
        const size = lootRegionSize(scale);
        return width === size.width && height === size.height;
    });
    const isRareRegion = ([80, 100] as const).some((scale) => {
        const size = RARE_LOOT_REGION_SIZES[scale];
        return width === size.width && height === size.height;
    });
    const boundedRegion =
        (kind !== 2 && kind !== 3) ||
        (isSupportedLootSource(sourceWidth, sourceHeight) &&
            (kind === 2 ? isNormalRegion : isRareRegion) &&
            cropX + width <= sourceWidth &&
            cropY + height <= sourceHeight);
    if (
        !validKind ||
        captureId === 0 ||
        batchId === 0 ||
        width === 0 ||
        height === 0 ||
        sourceWidth === 0 ||
        sourceHeight === 0 ||
        !boundedPreview ||
        !boundedRegion ||
        bytes.byteLength !== NATIVE_FRAME_HEADER_BYTES + width * height * 4
    ) {
        throw new Error("Native display capture returned an invalid frame.");
    }
    return {
        kind: kind === 1 ? "preview" : kind === 2 ? "region" : "rare-region",
        captureId,
        batchId,
        pixels: new Uint8ClampedArray(message, NATIVE_FRAME_HEADER_BYTES),
        width,
        height,
        sourceWidth,
        sourceHeight,
        cropX,
        cropY,
    };
}

export function supportsTauriApi() {
    return isTauri();
}

export function supportsNativeDisplayCapture() {
    return isTauri() && navigator.userAgent.includes("Linux");
}

export function startNativeDisplayCapture(
    selection: LootCaptureSettings | null,
    onFrame: (frame: NativeCaptureFrame) => void,
    onError: (message: string) => void,
) {
    const frames = new Channel<ArrayBuffer>((message) => {
        let frame: NativeCaptureFrame | undefined;
        try {
            const parsed = parseNativeCaptureMessage(message);
            if (parsed.kind === "error") onError(parsed.message);
            else {
                frame = parsed;
                onFrame(parsed);
            }
        } catch (error) {
            onError(error instanceof Error ? error.message : String(error));
        } finally {
            if (frame) {
                void Promise.resolve(
                    invoke("acknowledge_native_display_frame", {
                        captureId: frame.captureId,
                        batchId: frame.batchId,
                        kind: frame.kind === "preview" ? 1 : frame.kind === "region" ? 2 : 3,
                    }),
                ).catch((error) => {
                    const detail = error instanceof Error ? error.message : String(error);
                    onError(`Native display capture acknowledgement failed: ${detail}`);
                });
            }
        }
    });
    return invoke<void>("start_native_display_capture", { frames, selection });
}

export function setNativeDisplayCaptureRegion(selection: LootCaptureSettings | null) {
    return invoke<void>("set_native_display_capture_region", { selection });
}

export function stopNativeDisplayCapture() {
    return invoke<void>("stop_native_display_capture");
}

export function loadLootCaptureSettings() {
    return invoke<LootCaptureSettings | null>("load_loot_capture_settings");
}

export function saveLootCaptureSettings(settings: LootCaptureSettings) {
    return invoke<void>("save_loot_capture_settings", { settings });
}
