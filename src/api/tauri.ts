import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ConsumablePreset } from "../domain/consumablePreset";
import type { HistoryQuery, SpotSummary } from "../domain/history";
import type { SessionEntry, SessionState } from "../domain/session";
import type { SessionTrendData } from "../domain/trend";
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

export async function loadSessionTrend(sessionId: string): Promise<SessionTrendData> {
    const trend = await invoke<SessionTrendData | null>("load_session_trend", { sessionId });
    return {
        samples: Array.isArray(trend?.samples) ? trend.samples : [],
        drops: Array.isArray(trend?.drops) ? trend.drops : [],
    };
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
const NATIVE_FRAME_PROTOCOL_VERSION = 4;
const NATIVE_FRAME_KINDS = { 1: "preview", 2: "region", 3: "rare-region", 4: "search-region" } as const;

function invalidFrame() {
    return new Error("Native display capture returned an invalid frame.");
}

/**
 * Parses one capture message: a batch's frames back to back, or a lone error. Pixels are views into `message`, so a
 * retained frame keeps the whole message alive. Crops in a batch with a setup preview get their own copy instead, so
 * recognition queues never hold on to previews.
 */
export function parseNativeCaptureMessage(message: ArrayBuffer): NativeCaptureFrame[] | NativeCaptureError {
    const frames: NativeCaptureFrame[] = [];
    let offset = 0;
    while (offset < message.byteLength) {
        if (message.byteLength - offset < NATIVE_FRAME_HEADER_BYTES) throw invalidFrame();
        const header = new DataView(message, offset, NATIVE_FRAME_HEADER_BYTES);
        const version = header.getUint32(0, true);
        const kind = header.getUint32(4, true);
        if (version !== NATIVE_FRAME_PROTOCOL_VERSION) {
            throw new Error("Native display capture returned an unsupported frame version.");
        }
        if (kind === 0) {
            if (offset !== 0) throw invalidFrame();
            const text = new Uint8Array(message, NATIVE_FRAME_HEADER_BYTES);
            return { kind: "error", message: new TextDecoder().decode(text) };
        }

        const captureId = header.getUint32(8, true);
        const batchId = header.getUint32(12, true);
        const width = header.getUint32(16, true);
        const height = header.getUint32(20, true);
        const sourceWidth = header.getUint32(24, true);
        const sourceHeight = header.getUint32(28, true);
        const cropX = header.getUint32(32, true);
        const cropY = header.getUint32(36, true);
        const frameKind = NATIVE_FRAME_KINDS[kind as keyof typeof NATIVE_FRAME_KINDS] as
            | NativeCaptureFrame["kind"]
            | undefined;
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
        const pixelBytes = width * height * 4;
        const first = frames[0];
        if (
            !frameKind ||
            captureId === 0 ||
            batchId === 0 ||
            width === 0 ||
            height === 0 ||
            sourceWidth === 0 ||
            sourceHeight === 0 ||
            !boundedPreview ||
            !boundedRegion ||
            !boundedSearchRegion ||
            message.byteLength - offset - NATIVE_FRAME_HEADER_BYTES < pixelBytes ||
            (first && (first.captureId !== captureId || first.batchId !== batchId)) ||
            frames.some((frame) => frame.kind === frameKind)
        ) {
            throw invalidFrame();
        }
        frames.push({
            kind: frameKind,
            captureId,
            batchId,
            pixels: new Uint8ClampedArray(message, offset + NATIVE_FRAME_HEADER_BYTES, pixelBytes),
            width,
            height,
            sourceWidth,
            sourceHeight,
            cropX,
            cropY,
        });
        offset += NATIVE_FRAME_HEADER_BYTES + pixelBytes;
    }
    if (!frames.length) throw invalidFrame();
    if (frames.length > 1 && frames.some((frame) => frame.kind === "preview")) {
        for (const frame of frames) if (frame.kind !== "preview") frame.pixels = frame.pixels.slice();
    }
    return frames;
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
        let batch: NativeCaptureFrame[];
        try {
            const parsed = parseNativeCaptureMessage(message);
            if (!Array.isArray(parsed)) {
                onError(parsed.message);
                return;
            }
            batch = parsed;
        } catch (error) {
            onError(error instanceof Error ? error.message : String(error));
            return;
        }
        for (const frame of batch) {
            try {
                onFrame(frame);
            } catch (error) {
                onError(error instanceof Error ? error.message : String(error));
            }
        }
        // One acknowledgment releases the whole batch; capture sends the next one only after it.
        const { captureId, batchId } = batch[0];
        void Promise.resolve(invoke("acknowledge_native_display_batch", { captureId, batchId })).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            onError(`Native display capture acknowledgement failed: ${detail}`);
        });
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

export async function loadDebugRoiSamplesEnabled() {
    // Only development builds have the collector, so recording is never enabled elsewhere.
    if (!import.meta.env.DEV || !supportsTauriApi()) return false;
    return invoke<boolean>("load_debug_roi_samples_enabled");
}

export function saveDebugRoiSamplesEnabled(enabled: boolean) {
    return invoke<void>("save_debug_roi_samples_enabled", { enabled });
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
