import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ConsumablePreset } from "../domain/consumablePreset";
import type { HistoryQuery, SpotSummary } from "../domain/history";
import type { SessionEntry, SessionState } from "../domain/session";
import type { TrendSample } from "../domain/trend";
import {
    isSupportedLootSource,
    LOOT_SEARCH_REGION_SIZE,
    type LootUiScale,
    lootRegionSize,
    type NormalizedRegion,
    RARE_LOOT_REGION_SIZES,
} from "../recognition/displayCapture";
import type { LootFont } from "../recognition/lootFont";
import type { RoiOcrIssue } from "../recognition/roiOcrDiagnostics";

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
    buffIds: number[];
    /** Debug builds only. */
    consumableDiagnostics: boolean;
};

export type GarmothUploadInput = {
    sessionId: string;
    repeatUpload?: boolean;
    grindspotId: number;
    minutes: number;
    hourly: number;
    total: number;
    drops: Record<string, number>;
    global: boolean;
    agris?: number;
    buffs?: number[];
    expectedSession: SessionState;
    consumableEntries?: SessionEntry[];
};

export type GarmothUploadResult = {
    status: "success" | "unknown" | "failed";
    message: string;
    savedSession: SessionState | null;
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

export type HistoryResult = {
    records: FinishedSessionRecord[];
    totalCount: number;
    offset: number;
    spotSummaries: SpotSummary[];
};

export async function loadSessionTrend(sessionId: string): Promise<TrendSample[]> {
    const samples = await invoke<TrendSample[] | null>("load_session_trend", { sessionId });
    return Array.isArray(samples) ? samples : [];
}

export function listFinishedSessions(query: HistoryQuery) {
    return invoke<HistoryResult>("list_finished_sessions", { query });
}

export function deleteFinishedSession(id: string) {
    return invoke<void>("delete_finished_session", { id });
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

/**
 * Records what the user found on Garmoth for an upload Garmoth never confirmed, and returns the session's new status. An
 * unconfirmed repeat upload stays `success` either way, because the earlier upload is on Garmoth.
 */
export function resolveGarmothUpload(sessionId: string, uploaded: boolean) {
    return invoke<"success" | null>("resolve_garmoth_upload", { sessionId, uploaded });
}

export function uploadGarmothSession(input: GarmothUploadInput) {
    return invoke<GarmothUploadResult>("upload_garmoth_session", { input });
}

export type NativeCaptureFrame = {
    kind: "preview" | "region" | "rare-region" | "search-region";
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
    font?: LootFont;
    region: NormalizedRegion;
    rareRegion?: NormalizedRegion | null;
    rareRegionConfirmed: boolean;
    sourceWidth: number;
    sourceHeight: number;
    uiScalePercent: LootUiScale;
};

export type DebugRoiSampleCollectionStatus = {
    phase: "idle" | "running" | "finalizing" | "finished" | "failed";
    path: string | null;
    acceptedBatchCount: number;
    droppedBatchCount: number;
    writtenBatchCount: number;
    bytesWritten: number;
    error: string | null;
    finishReason: string | null;
    startedAtUnixMs: number | null;
    deadlineAtUnixMs: number | null;
};

export type NativeCaptureSelection =
    | {
          mode: "search";
          region: NormalizedRegion;
          sourceWidth: number;
          sourceHeight: number;
          uiScalePercent: LootUiScale;
      }
    | { mode: "regions"; settings: LootCaptureSettings };

const NATIVE_FRAME_HEADER_BYTES = 40;
const NATIVE_FRAME_PROTOCOL_VERSION = 3;
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
    const validKind = kind === 1 || kind === 2 || kind === 3 || kind === 4;
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
    const boundedSearchRegion =
        kind !== 4 ||
        (width === LOOT_SEARCH_REGION_SIZE.width &&
            height === LOOT_SEARCH_REGION_SIZE.height &&
            isSupportedLootSource(sourceWidth, sourceHeight) &&
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
        !boundedSearchRegion ||
        bytes.byteLength !== NATIVE_FRAME_HEADER_BYTES + width * height * 4
    ) {
        throw new Error("Native display capture returned an invalid frame.");
    }
    return {
        kind: kind === 1 ? "preview" : kind === 2 ? "region" : kind === 3 ? "rare-region" : "search-region",
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

export type NativeCaptureCapabilities = {
    backend: "linux" | "windows" | null;
    available: boolean;
    reason: string | null;
    debugRoiSamples: boolean;
};

export function nativeCaptureCapabilities(): Promise<NativeCaptureCapabilities> {
    if (!isTauri()) return Promise.resolve({ backend: null, available: false, reason: null, debugRoiSamples: false });
    return invoke<NativeCaptureCapabilities>("native_capture_capabilities");
}

export function startNativeDisplayCapture(
    captureToken: number,
    selection: NativeCaptureSelection | LootCaptureSettings | null,
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
                        kind:
                            frame.kind === "preview"
                                ? 1
                                : frame.kind === "region"
                                  ? 2
                                  : frame.kind === "rare-region"
                                    ? 3
                                    : 4,
                    }),
                ).catch((error) => {
                    const detail = error instanceof Error ? error.message : String(error);
                    onError(`Native display capture acknowledgement failed: ${detail}`);
                });
            }
        }
    });
    return invoke<void>("start_native_display_capture", {
        captureToken,
        frames,
        selection: nativeCaptureSelection(selection),
    });
}

function nativeCaptureSelection(
    selection: NativeCaptureSelection | LootCaptureSettings | null,
): NativeCaptureSelection | null {
    if (selection === null || "mode" in selection) return selection;
    return { mode: "regions", settings: selection };
}

export function setNativeDisplayCaptureRegion(
    captureToken: number,
    selection: NativeCaptureSelection | LootCaptureSettings | null,
) {
    return invoke<void>("set_native_display_capture_region", {
        captureToken,
        selection: nativeCaptureSelection(selection),
    });
}

export function setNativeDisplayCapturePreviewEnabled(captureToken: number, enabled: boolean) {
    return invoke<void>("set_native_display_capture_preview_enabled", { captureToken, enabled });
}

export function stopNativeDisplayCapture(captureToken: number) {
    return invoke<void>("stop_native_display_capture", { captureToken });
}

export function loadLootCaptureSettings() {
    return invoke<LootCaptureSettings | null>("load_loot_capture_settings");
}

export function saveLootCaptureSettings(settings: LootCaptureSettings) {
    return invoke<void>("save_loot_capture_settings", { settings });
}

export function startDebugRoiSampleCollection(captureToken: number) {
    return invoke<DebugRoiSampleCollectionStatus>("start_debug_roi_sample_collection", { captureToken });
}

export function stopDebugRoiSampleCollection(captureToken: number) {
    return invoke<DebugRoiSampleCollectionStatus>("stop_debug_roi_sample_collection", { captureToken });
}

export function debugRoiSampleCollectionStatus() {
    return invoke<DebugRoiSampleCollectionStatus>("debug_roi_sample_collection_status");
}

export function logRoiOcrIssue(issue: RoiOcrIssue) {
    return invoke<boolean>("log_debug_roi_ocr_issue", { issue });
}

export type LootLayoutPanel = { status: "found"; x: number; y: number } | { status: "unavailable"; message: string };

export function readLootLayout(
    xml: string,
): Promise<{ normal: LootLayoutPanel; rare: LootLayoutPanel; uiScalePercent: LootUiScale }> {
    return invoke("read_loot_layout", { xml });
}

export function inspectGarmothConsumables(characterId: string, includeFieldNames = false) {
    return invoke<string>("inspect_garmoth_consumables", { characterId, includeFieldNames });
}

export function loadConsumablePresets() {
    return invoke<ConsumablePreset[]>("load_consumable_presets");
}

export function saveConsumablePresets(presets: ConsumablePreset[]) {
    return invoke<void>("save_consumable_presets", { presets });
}
