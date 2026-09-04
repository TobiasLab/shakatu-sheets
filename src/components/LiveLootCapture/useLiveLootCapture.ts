import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    type DebugRoiSampleCollectionStatus,
    debugRoiSampleCollectionStatus,
    type LootCaptureSettings,
    loadLootCaptureSettings,
    type NativeCaptureFrame,
    type NativeCaptureSelection,
    saveLootCaptureSettings,
    setNativeDisplayCapturePreviewEnabled,
    setNativeDisplayCaptureRegion,
    startDebugRoiSampleCollection,
    startNativeDisplayCapture,
    stopDebugRoiSampleCollection,
    stopNativeDisplayCapture,
    supportsNativeDisplayCapture,
    supportsTauriApi,
} from "../../api/tauri";
import { isActiveSessionStatus, type SessionStatus } from "../../domain/session";
import { useWindowVisible } from "../../hooks/useWindowVisible";
import {
    DISPLAY_CAPTURE_OPTIONS,
    defaultLootRegion,
    displayCaptureErrorMessage,
    isSupportedLootSource,
    LOOT_SEARCH_REGION_SIZE,
    type LootRegionKind,
    type LootUiScale,
    lootAlignmentGuide,
    lootRegionSize,
    type NormalizedRegion,
    normalizedRegionToPixels,
    nudgeLootRegion,
    positionLootRegion,
    positionLootSearchRegion,
    searchRegionAroundLootRegion,
    stopDisplayCapture,
} from "../../recognition/displayCapture";
import {
    LiveLootCoordinator,
    type LiveLootOcrReader,
    type LiveLootRecognitionResult,
    type LootRoiFrame,
} from "../../recognition/liveLoot";
import { NormalLootLocalizer, type NormalLootSearchFrame } from "../../recognition/liveLootLocalization";
import {
    createLiveLootTesseractOcr,
    type LiveLootTesseractOcr,
    serializeLiveLootOcrReader,
} from "../../recognition/liveLootOcr";
import { findLiveLootProfile } from "../../recognition/liveLootProfiles";
import {
    acceptLiveLootReviewEntry,
    appendLiveLootReviewResult,
    type LiveLootReviewEntry,
} from "../../recognition/liveLootReview";
import {
    RARE_LOOT_OCR_BOUNDS,
    RARE_LOOT_OCR_SELECTION,
    RARE_LOOT_PROFILE,
    RareLootFrameAnalyzer,
} from "../../recognition/rareLoot";

type CaptureStatus = "idle" | "requesting" | "connecting" | "capturing";
type RecognitionStatus = "idle" | "starting" | "active" | "unavailable" | "error";
type PlacementMode = "localizing" | "aligned" | "manual";
type SourceDimensions = { width: number; height: number };
type RecognitionPipeline = {
    normalCoordinator: LiveLootCoordinator;
    rareCoordinator: LiveLootCoordinator;
    ocr: LiveLootTesseractOcr;
};
type AutomaticRetry = { timerId: number; retriesRemaining: number };
type OcrSource = LiveLootReviewEntry["source"];
type OcrPipelineDiagnostics = {
    outstandingJobs: number;
    peakOutstandingJobs: number;
};
type OcrWorkerDiagnostics = {
    completedJobs: number;
    totalDurationMs: number;
    lastDurationMs: number;
};
type OcrDiagnostics = Record<OcrSource, OcrPipelineDiagnostics> & {
    worker: OcrWorkerDiagnostics;
    analysis: OcrWorkerDiagnostics;
};
export type LiveLootCaptureProps = {
    setupRequest: number;
    visible: boolean;
    onStatusChange: (status: string) => void;
    databaseLoaded: boolean;
    sessionId: string;
    sessionStatus: SessionStatus;
    grindSpotId: string;
    grindSpotName: string;
    itemDictionary: readonly string[];
    onAcceptRecognition: (itemName: string, quantity: number) => string | null;
};

const AUTOMATIC_INSERTION_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;
const MAX_PENDING_RECOGNITION_FRAMES = 32;
const NORMAL_MAX_OUTSTANDING_OCR_JOBS = 8;
const RARE_MAX_OUTSTANDING_OCR_JOBS = 2;
let nextNativeCaptureToken = Date.now() * 1_000;

function emptyOcrDiagnostics(): OcrDiagnostics {
    return {
        normal: { outstandingJobs: 0, peakOutstandingJobs: 0 },
        rare: { outstandingJobs: 0, peakOutstandingJobs: 0 },
        worker: { completedJobs: 0, totalDurationMs: 0, lastDurationMs: 0 },
        analysis: { completedJobs: 0, totalDurationMs: 0, lastDurationMs: 0 },
    };
}

function sameOcrDiagnostics(left: OcrDiagnostics, right: OcrDiagnostics) {
    return (
        left.normal.outstandingJobs === right.normal.outstandingJobs &&
        left.normal.peakOutstandingJobs === right.normal.peakOutstandingJobs &&
        left.rare.outstandingJobs === right.rare.outstandingJobs &&
        left.rare.peakOutstandingJobs === right.rare.peakOutstandingJobs &&
        left.worker.completedJobs === right.worker.completedJobs &&
        left.worker.totalDurationMs === right.worker.totalDurationMs &&
        left.worker.lastDurationMs === right.worker.lastDurationMs &&
        left.analysis.completedJobs === right.analysis.completedJobs &&
        left.analysis.totalDurationMs === right.analysis.totalDurationMs &&
        left.analysis.lastDurationMs === right.analysis.lastDurationMs
    );
}

function formatOcrDuration(diagnostics: OcrWorkerDiagnostics) {
    if (diagnostics.completedJobs === 0) return "Waiting...";
    const average = diagnostics.totalDurationMs / diagnostics.completedJobs;
    return `${(diagnostics.lastDurationMs / 1_000).toFixed(1)}s last / ${(average / 1_000).toFixed(1)}s avg (${diagnostics.completedJobs})`;
}

function formatSampleCollectionCountdown(deadline: number | null, now: number) {
    const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1_000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSampleCollectionBytes(bytes: number) {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

function createNativeCaptureToken() {
    nextNativeCaptureToken += 1;
    return nextNativeCaptureToken;
}

function drawFrame(canvas: HTMLCanvasElement | null, frame: NativeCaptureFrame) {
    if (!canvas) return;
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
    }
    canvas.getContext("2d")?.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

function regionsEqual(left: NormalizedRegion | null, right: NormalizedRegion | null) {
    return (
        left === right ||
        (left !== null &&
            right !== null &&
            left.x === right.x &&
            left.y === right.y &&
            left.width === right.width &&
            left.height === right.height)
    );
}

function frameMatchesRegion(
    frame: NativeCaptureFrame,
    region: NormalizedRegion | null,
    source: SourceDimensions | null,
) {
    if (!source || !region) return false;
    const pixels = normalizedRegionToPixels(region, source.width, source.height);
    return (
        frame.sourceWidth === source.width &&
        frame.sourceHeight === source.height &&
        frame.cropX === pixels.x &&
        frame.cropY === pixels.y &&
        frame.width === pixels.width &&
        frame.height === pixels.height
    );
}

function regionsCaptureSelection(
    normalRegion: NormalizedRegion | null,
    rareRegion: NormalizedRegion | null,
    source: SourceDimensions | null,
    uiScalePercent: LootUiScale,
    rareRegionConfirmed: boolean,
): NativeCaptureSelection | null {
    if (!normalRegion || !rareRegion || !source) return null;
    const normalPixels = normalizedRegionToPixels(normalRegion, source.width, source.height);
    const rarePixels = normalizedRegionToPixels(rareRegion, source.width, source.height);
    const expectedNormal = lootRegionSize(uiScalePercent, "normal");
    const expectedRare = lootRegionSize(uiScalePercent, "rare");
    if (
        normalPixels.width !== expectedNormal.width ||
        normalPixels.height !== expectedNormal.height ||
        rarePixels.width !== expectedRare.width ||
        rarePixels.height !== expectedRare.height
    )
        return null;
    return {
        mode: "regions",
        settings: {
            region: normalRegion,
            rareRegion,
            rareRegionConfirmed,
            sourceWidth: source.width,
            sourceHeight: source.height,
            uiScalePercent,
        },
    };
}

function resultDescription(result: LiveLootRecognitionResult) {
    if (result.status === "recognized") return `${result.itemName} x ${result.quantity}`;
    if (result.status === "failed") return "Local OCR failed for this notification.";
    if (result.status === "dropped") {
        const cause =
            result.reason === "backpressure-summary"
                ? "the OCR job capacity was full"
                : result.reason === "result-overflow-summary"
                  ? "recognition results could not be retained"
                  : "recognition capacity was exceeded";
        return `${result.count} notifications dropped because ${cause}.`;
    }
    if (result.reason === "insufficient-observations") return "Notification disappeared before three stable frames.";
    if (result.reason === "item-not-recognized") return "OCR item did not match the active grind spot.";
    if (result.reason === "quantity-not-recognized") return "OCR did not find a stable quantity suffix.";
    return "No item and quantity pair reached consensus.";
}

function resultAnnouncement(
    entry: LiveLootReviewEntry,
    automaticRetriesRemaining?: number,
    manualRetryAttempt?: number,
) {
    const source = entry.source === "rare" ? "rare banner" : "normal loot";
    const description = resultDescription(entry.result);
    if (entry.result.status !== "recognized") return `Result ${entry.id + 1}, ${source}: ${description}`;
    if (entry.accepted) return `Result ${entry.id + 1}, ${source}: ${description}. Added to the session.`;
    if (entry.error) {
        const nextAction =
            automaticRetriesRemaining === undefined
                ? "Select Retry add."
                : automaticRetriesRemaining > 0
                  ? `${automaticRetriesRemaining} automatic ${automaticRetriesRemaining === 1 ? "retry remains" : "retries remain"}.`
                  : "Automatic retries exhausted. Select Retry add.";
        const attempt = manualRetryAttempt ? `Manual retry ${manualRetryAttempt} failed. ` : "";
        return `Result ${entry.id + 1}, ${source}: ${description}. ${attempt}Insertion failed: ${entry.error}. ${nextAction}`;
    }
    return `Result ${entry.id + 1}, ${source}: ${description}. Automatic insertion is pending.`;
}

export function useLiveLootCapture({
    setupRequest,
    visible,
    onStatusChange,
    databaseLoaded,
    sessionId,
    sessionStatus,
    grindSpotId,
    grindSpotName,
    itemDictionary,
    onAcceptRecognition,
}: LiveLootCaptureProps) {
    const windowVisible = useWindowVisible();
    const [setupOpen, setSetupOpen] = useState(false);
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const previewUpdates = useRef(Promise.resolve());
    const setupButton = useRef<HTMLButtonElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const normalRegionCanvas = useRef<HTMLCanvasElement>(null);
    const rareRegionCanvas = useRef<HTMLCanvasElement>(null);
    const pausedNormalRegionCanvas = useRef<HTMLCanvasElement | null>(null);
    const pausedRareRegionCanvas = useRef<HTMLCanvasElement | null>(null);
    const searchRegionCanvas = useRef<HTMLCanvasElement | null>(null);
    const activeStream = useRef<MediaStream | null>(null);
    const nativeCapture = useRef(false);
    const nativeCaptureToken = useRef<number | null>(null);
    const receivedNativeFrame = useRef(false);
    const lastNativeSampleBatch = useRef(0);
    const previewsEnabledRef = useRef(true);
    const sampledFrames = useRef(0);
    const diagnosticsVisible = useRef(false);
    useLayoutEffect(() => {
        diagnosticsVisible.current = diagnosticsOpen && visible && windowVisible;
    }, [diagnosticsOpen, visible, windowVisible]);
    const measurementStarted = useRef(performance.now());
    const requestId = useRef(0);
    const nativeSelectionUpdate = useRef<Promise<void>>(Promise.resolve());
    const nativeSelectionRevision = useRef(0);
    const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
    const nextSettingsSaveId = useRef(0);
    const mounted = useRef(true);
    const activeSessionId = useRef(sessionId);
    const draggingRegion = useRef(false);
    const activeRegionKindRef = useRef<LootRegionKind>("normal");
    const configuredSource = useRef("");
    const normalRegionRef = useRef<NormalizedRegion | null>(null);
    const rareRegionRef = useRef<NormalizedRegion | null>(null);
    const placementModeRef = useRef<PlacementMode>("manual");
    const searchRegionRef = useRef<NormalizedRegion | null>(null);
    const regionConfirmedRef = useRef(false);
    const rareRegionConfirmedRef = useRef(false);
    const normalCaptureRegionRef = useRef<NormalizedRegion | null>(null);
    const rareCaptureRegionRef = useRef<NormalizedRegion | null>(null);
    const sourceDimensionsRef = useRef<SourceDimensions | null>(null);
    const uiScaleRef = useRef<LootUiScale>(80);
    const recognition = useRef<RecognitionPipeline | null>(null);
    const recognitionGeneration = useRef(0);
    const recognitionStartup = useRef<Promise<void> | null>(null);
    const recognitionRequestedRef = useRef(false);
    const ocrDiagnosticsRef = useRef<OcrDiagnostics>(emptyOcrDiagnostics());
    const sampleCollectionRevision = useRef(0);
    const pendingLocalizationReplay = useRef<LootRoiFrame[]>([]);
    const pendingRecognitionFrames = useRef<LootRoiFrame[]>([]);
    const pendingRareRecognitionFrames = useRef<LootRoiFrame[]>([]);
    const pendingRecognitionOverflowed = useRef(false);
    const localizer = useRef<NormalLootLocalizer | null>(null);
    const nextReviewResultId = useRef(0);
    const reviewResultsRef = useRef<LiveLootReviewEntry[]>([]);
    const automaticRetries = useRef(new Map<number, AutomaticRetry>());
    const manualRetryAttempts = useRef(new Map<number, number>());
    const itemDictionaryRef = useRef(itemDictionary);
    const onAcceptRecognitionRef = useRef(onAcceptRecognition);
    const [status, setStatus] = useState<CaptureStatus>("idle");
    const [error, setError] = useState("");
    const [sampledFps, setSampledFps] = useState(0);
    const [previewsEnabled, setPreviewsEnabled] = useState(true);
    const [previewToggleBusy, setPreviewToggleBusy] = useState(false);
    const [previewToggleError, setPreviewToggleError] = useState("");
    const [sourceDimensions, setSourceDimensions] = useState<SourceDimensions | null>(null);
    const [normalRegionFrameSize, setNormalRegionFrameSize] = useState<SourceDimensions | null>(null);
    const [rareRegionFrameSize, setRareRegionFrameSize] = useState<SourceDimensions | null>(null);
    const [savedSettings, setSavedSettings] = useState<LootCaptureSettings | null>(null);
    const [settingsLoaded, setSettingsLoaded] = useState(() => !supportsTauriApi());
    const [normalRegion, setNormalRegion] = useState<NormalizedRegion | null>(null);
    const [rareRegion, setRareRegion] = useState<NormalizedRegion | null>(null);
    const [placementMode, setPlacementMode] = useState<PlacementMode>("manual");
    const [searchRegion, setSearchRegion] = useState<NormalizedRegion | null>(null);
    const [normalCaptureRegion, setNormalCaptureRegion] = useState<NormalizedRegion | null>(null);
    const [rareCaptureRegion, setRareCaptureRegion] = useState<NormalizedRegion | null>(null);
    const [activeRegionKind, setActiveRegionKind] = useState<LootRegionKind>("normal");
    const [uiScalePercent, setUiScalePercent] = useState<LootUiScale>(80);
    const [regionConfirmed, setRegionConfirmed] = useState(false);
    const [rareRegionConfirmed, setRareRegionConfirmed] = useState(false);
    const [savingRegion, setSavingRegion] = useState(false);
    const [recognitionStatus, setRecognitionStatus] = useState<RecognitionStatus>("idle");
    const [recognitionError, setRecognitionError] = useState("");
    const [recognitionReset, setRecognitionReset] = useState(0);
    const [ocrDiagnostics, setOcrDiagnostics] = useState<OcrDiagnostics>(emptyOcrDiagnostics);
    const [reviewResults, setReviewResults] = useState<LiveLootReviewEntry[]>([]);
    const [omittedReviewResults, setOmittedReviewResults] = useState(0);
    const [recognitionAnnouncement, setRecognitionAnnouncement] = useState("");
    const [sampleCollection, setSampleCollection] = useState<DebugRoiSampleCollectionStatus | null>(null);
    const [sampleCollectionBusy, setSampleCollectionBusy] = useState(false);
    const [sampleCollectionError, setSampleCollectionError] = useState("");
    const [sampleCollectionNow, setSampleCollectionNow] = useState(Date.now());
    const [debugSampleCollectionAvailable, setDebugSampleCollectionAvailable] = useState(false);
    const [nativeAppliedSelectionKey, setNativeAppliedSelectionKey] = useState("");
    const debugSampleCollectionCandidate = import.meta.env.DEV && supportsNativeDisplayCapture();
    const sessionActive = isActiveSessionStatus(sessionStatus);
    const captureAllowed = databaseLoaded && sessionActive;

    useLayoutEffect(() => {
        activeSessionId.current = sessionId;
        itemDictionaryRef.current = itemDictionary;
        onAcceptRecognitionRef.current = onAcceptRecognition;
    }, [itemDictionary, onAcceptRecognition, sessionId]);

    useEffect(() => {
        if (!debugSampleCollectionCandidate) return;
        let cancelled = false;
        const revision = ++sampleCollectionRevision.current;
        void debugRoiSampleCollectionStatus()
            .then((current) => {
                if (cancelled || revision !== sampleCollectionRevision.current) return;
                setDebugSampleCollectionAvailable(true);
                if (current.phase !== "idle") setSampleCollection(current);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [debugSampleCollectionCandidate]);

    function updateRegion(kind: LootRegionKind, next: NormalizedRegion | null) {
        if (kind === "normal") {
            normalRegionRef.current = next;
            setNormalRegion(next);
        } else {
            rareRegionRef.current = next;
            setRareRegion(next);
        }
    }

    function updateCaptureRegion(kind: LootRegionKind, next: NormalizedRegion | null) {
        if (kind === "normal") {
            if (!regionsEqual(normalCaptureRegionRef.current, next)) setNativeAppliedSelectionKey("");
            normalCaptureRegionRef.current = next;
            setNormalCaptureRegion(next);
        } else {
            if (!regionsEqual(rareCaptureRegionRef.current, next)) setNativeAppliedSelectionKey("");
            rareCaptureRegionRef.current = next;
            setRareCaptureRegion(next);
        }
    }

    function updatePlacementMode(next: PlacementMode) {
        if (placementModeRef.current !== next) setNativeAppliedSelectionKey("");
        placementModeRef.current = next;
        setPlacementMode(next);
    }

    function updateSearchRegion(next: NormalizedRegion | null) {
        if (!regionsEqual(searchRegionRef.current, next)) setNativeAppliedSelectionKey("");
        searchRegionRef.current = next;
        setSearchRegion(next);
    }

    function updateRegionConfirmed(next: boolean) {
        regionConfirmedRef.current = next;
        setRegionConfirmed(next);
    }

    function updateRareRegionConfirmed(next: boolean) {
        if (rareRegionConfirmedRef.current !== next) setNativeAppliedSelectionKey("");
        rareRegionConfirmedRef.current = next;
        setRareRegionConfirmed(next);
    }

    function regionIsReady(kind: LootRegionKind) {
        return kind === "normal"
            ? placementModeRef.current === "aligned" || regionConfirmedRef.current
            : rareRegionConfirmedRef.current;
    }

    function selectRegionKind(kind: LootRegionKind) {
        activeRegionKindRef.current = kind;
        setActiveRegionKind(kind);
    }

    function clearRegionPreview(kind: LootRegionKind) {
        if (kind === "normal") {
            setNormalRegionFrameSize(null);
            clearCanvas(normalRegionCanvas.current);
            clearCanvas(pausedNormalRegionCanvas.current);
        } else {
            setRareRegionFrameSize(null);
            clearCanvas(rareRegionCanvas.current);
            clearCanvas(pausedRareRegionCanvas.current);
        }
    }

    function updateSourceDimensions(next: SourceDimensions | null) {
        const current = sourceDimensionsRef.current;
        if (current?.width !== next?.width || current?.height !== next?.height) setNativeAppliedSelectionKey("");
        sourceDimensionsRef.current = next;
        setSourceDimensions(next);
    }

    function updateUiScale(next: LootUiScale) {
        if (uiScaleRef.current !== next) setNativeAppliedSelectionKey("");
        uiScaleRef.current = next;
        setUiScalePercent(next);
    }

    function clearLocalization() {
        localizer.current?.clear();
        localizer.current = null;
        pendingLocalizationReplay.current.length = 0;
        pendingRecognitionFrames.current.length = 0;
        pendingRareRecognitionFrames.current.length = 0;
        pendingRecognitionOverflowed.current = false;
        if (searchRegionCanvas.current) {
            searchRegionCanvas.current.width = 0;
            searchRegionCanvas.current.height = 0;
        }
    }

    function recordOutstandingOcrJobs(source: OcrSource, outstandingJobs: number) {
        const diagnostics = ocrDiagnosticsRef.current[source];
        diagnostics.outstandingJobs = outstandingJobs;
        diagnostics.peakOutstandingJobs = Math.max(diagnostics.peakOutstandingJobs, outstandingJobs);
    }

    function publishOcrDiagnostics() {
        const current = ocrDiagnosticsRef.current;
        const next = {
            normal: { ...current.normal },
            rare: { ...current.rare },
            worker: { ...current.worker },
            analysis: { ...current.analysis },
        };
        setOcrDiagnostics((published) => (sameOcrDiagnostics(published, next) ? published : next));
    }

    function recordFrameAnalysis(started: number | null) {
        if (started === null) return;
        const diagnostics = ocrDiagnosticsRef.current.analysis;
        const duration = performance.now() - started;
        diagnostics.completedJobs += 1;
        diagnostics.totalDurationMs += duration;
        diagnostics.lastDurationMs = duration;
    }

    function measuredOcrReader(readText: LiveLootOcrReader, generation: number): LiveLootOcrReader {
        return async (frames, signal) => {
            if (!diagnosticsVisible.current) return readText(frames, signal);
            const started = performance.now();
            try {
                return await readText(frames, signal);
            } finally {
                if (generation === recognitionGeneration.current) {
                    const diagnostics = ocrDiagnosticsRef.current.worker;
                    const duration = performance.now() - started;
                    diagnostics.completedJobs += 1;
                    diagnostics.totalDurationMs += duration;
                    diagnostics.lastDurationMs = duration;
                }
            }
        };
    }

    function stopRecognition(updateStatus = true) {
        recognitionGeneration.current += 1;
        pendingLocalizationReplay.current.length = 0;
        pendingRecognitionFrames.current.length = 0;
        pendingRareRecognitionFrames.current.length = 0;
        pendingRecognitionOverflowed.current = false;
        const current = recognition.current;
        recognition.current = null;
        current?.normalCoordinator.stop();
        current?.rareCoordinator.stop();
        if (current) void current.ocr.terminate().catch(() => undefined);
        recordOutstandingOcrJobs("normal", 0);
        recordOutstandingOcrJobs("rare", 0);
        if (mounted.current) {
            publishOcrDiagnostics();
            if (updateStatus) setRecognitionStatus("idle");
        }
    }

    function pushRecognitionFrame(frame: LootRoiFrame) {
        const current = recognition.current;
        if (!current) {
            if (recognitionRequestedRef.current) {
                // Keep a contiguous recent window so OCR startup never bridges a gap in event tracking.
                if (pendingRecognitionFrames.current.length === MAX_PENDING_RECOGNITION_FRAMES) {
                    pendingRecognitionFrames.current.shift();
                    pendingRecognitionOverflowed.current = true;
                }
                pendingRecognitionFrames.current.push(frame);
            }
            return;
        }
        try {
            const started = diagnosticsVisible.current ? performance.now() : null;
            current.normalCoordinator.pushFrame(frame);
            recordFrameAnalysis(started);
            recordOutstandingOcrJobs("normal", current.normalCoordinator.pendingOcrJobCount);
        } catch (frameError) {
            stopRecognition(false);
            setRecognitionStatus("error");
            setRecognitionError(frameError instanceof Error ? frameError.message : String(frameError));
        }
    }

    function pushRareRecognitionFrame(frame: LootRoiFrame) {
        const current = recognition.current;
        if (!current) {
            if (recognitionRequestedRef.current) {
                if (pendingRareRecognitionFrames.current.length === MAX_PENDING_RECOGNITION_FRAMES) {
                    pendingRareRecognitionFrames.current.shift();
                }
                pendingRareRecognitionFrames.current.push(frame);
            }
            return;
        }
        try {
            const started = diagnosticsVisible.current ? performance.now() : null;
            current.rareCoordinator.pushFrame(frame);
            recordFrameAnalysis(started);
            recordOutstandingOcrJobs("rare", current.rareCoordinator.pendingOcrJobCount);
        } catch (frameError) {
            stopRecognition(false);
            setRecognitionStatus("error");
            setRecognitionError(frameError instanceof Error ? frameError.message : String(frameError));
        }
    }

    function restartRecognition() {
        stopRecognition(false);
        setRecognitionError("");
        setRecognitionReset((current) => current + 1);
    }

    function cancelAutomaticRetry(id: number) {
        const retry = automaticRetries.current.get(id);
        if (!retry) return 0;
        window.clearTimeout(retry.timerId);
        automaticRetries.current.delete(id);
        return retry.retriesRemaining;
    }

    function clearAutomaticRetries() {
        for (const retry of automaticRetries.current.values()) window.clearTimeout(retry.timerId);
        automaticRetries.current.clear();
    }

    function replaceReviewEntry(
        entry: LiveLootReviewEntry,
        automaticRetriesRemaining?: number,
        manualRetryAttempt?: number,
    ) {
        let retained = false;
        const next = reviewResultsRef.current.map((candidate) => {
            if (candidate.id !== entry.id) return candidate;
            retained = true;
            return entry;
        });
        if (!retained) return;
        reviewResultsRef.current = next;
        setReviewResults(next);
        setRecognitionAnnouncement(resultAnnouncement(entry, automaticRetriesRemaining, manualRetryAttempt));
    }

    function scheduleAutomaticRetry(entry: LiveLootReviewEntry, retriesRemaining: number) {
        if (entry.accepted || entry.result.status !== "recognized" || retriesRemaining < 1) return;
        cancelAutomaticRetry(entry.id);
        const retrySessionId = activeSessionId.current;
        const delayIndex = AUTOMATIC_INSERTION_RETRY_DELAYS.length - retriesRemaining;
        const timerId = window.setTimeout(() => {
            const pending = automaticRetries.current.get(entry.id);
            if (!pending || pending.timerId !== timerId) return;
            automaticRetries.current.delete(entry.id);
            if (!mounted.current || activeSessionId.current !== retrySessionId) return;
            const current = reviewResultsRef.current.find((candidate) => candidate.id === entry.id) ?? entry;
            const retried = acceptLiveLootReviewEntry(current, onAcceptRecognitionRef.current);
            replaceReviewEntry(retried, retriesRemaining - 1);
            if (retried.accepted) manualRetryAttempts.current.delete(entry.id);
            scheduleAutomaticRetry(retried, retriesRemaining - 1);
        }, AUTOMATIC_INSERTION_RETRY_DELAYS[delayIndex]);
        automaticRetries.current.set(entry.id, { timerId, retriesRemaining });
    }

    function acceptReviewResult(id: number) {
        const review = reviewResultsRef.current.find((candidate) => candidate.id === id);
        if (!review || review.accepted || review.result.status !== "recognized") return;
        const manualRetryAttempt = (manualRetryAttempts.current.get(id) ?? 0) + 1;
        manualRetryAttempts.current.set(id, manualRetryAttempt);
        const retried = acceptLiveLootReviewEntry(review, onAcceptRecognitionRef.current);
        replaceReviewEntry(retried, automaticRetries.current.get(id)?.retriesRemaining, manualRetryAttempt);
        if (retried.accepted) {
            cancelAutomaticRetry(id);
            manualRetryAttempts.current.delete(id);
        }
    }

    function clearReviewResults() {
        clearAutomaticRetries();
        manualRetryAttempts.current.clear();
        reviewResultsRef.current = [];
        setReviewResults([]);
        setOmittedReviewResults(0);
        setRecognitionAnnouncement("");
    }

    function queueSettingsSave(settings: LootCaptureSettings) {
        const saveId = ++nextSettingsSaveId.current;
        const saveRequest = requestId.current;
        const save = settingsSaveQueue.current.then(async () => {
            if (supportsTauriApi()) await saveLootCaptureSettings(settings);
        });
        settingsSaveQueue.current = save.catch(() => undefined);
        return save
            .then(() => {
                if (!mounted.current || saveId !== nextSettingsSaveId.current) return false;
                setSavedSettings(settings);
                return saveRequest === requestId.current;
            })
            .catch((saveError) => {
                if (!mounted.current || saveRequest !== requestId.current || saveId !== nextSettingsSaveId.current)
                    return false;
                setError(saveError instanceof Error ? saveError.message : String(saveError));
                return false;
            });
    }

    function lockAutomaticLocalization(region: NormalizedRegion, replayFrames: LootRoiFrame[]) {
        const currentSource = sourceDimensionsRef.current;
        if (
            placementModeRef.current !== "localizing" ||
            !currentSource ||
            !findLiveLootProfile(currentSource.width, currentSource.height, uiScaleRef.current)
        )
            return;

        localizer.current = null;
        updateSearchRegion(null);
        updateRegion("normal", region);
        updateCaptureRegion("normal", region);
        updatePlacementMode("aligned");
        updateRegionConfirmed(rareRegionConfirmedRef.current);
        if (!rareRegionConfirmedRef.current) selectRegionKind("rare");
        clearRegionPreview("normal");
        if (searchRegionCanvas.current) {
            searchRegionCanvas.current.width = 0;
            searchRegionCanvas.current.height = 0;
        }
        if (recognition.current) {
            for (const frame of replayFrames) pushRecognitionFrame(frame);
        } else {
            pendingLocalizationReplay.current = replayFrames;
        }

        const finalRare =
            rareRegionRef.current ??
            defaultLootRegion(currentSource.width, currentSource.height, uiScaleRef.current, "rare");
        if (!rareRegionRef.current) updateRegion("rare", finalRare);
        updateCaptureRegion("rare", finalRare);
        void queueSettingsSave({
            region,
            rareRegion: rareRegionConfirmedRef.current ? finalRare : null,
            rareRegionConfirmed: rareRegionConfirmedRef.current,
            sourceWidth: currentSource.width,
            sourceHeight: currentSource.height,
            uiScalePercent: uiScaleRef.current,
        });
    }

    function pushLocalizationFrame(frame: NormalLootSearchFrame) {
        if (placementModeRef.current !== "localizing") return;
        const currentLocalizer = localizer.current;
        if (!currentLocalizer) return;
        try {
            const started = diagnosticsVisible.current ? performance.now() : null;
            const result = currentLocalizer.pushFrame(frame);
            recordFrameAnalysis(started);
            if (result) lockAutomaticLocalization(result.region, result.replayFrames);
        } catch (localizationError) {
            clearLocalization();
            updateSearchRegion(null);
            updatePlacementMode("manual");
            updateRegionConfirmed(false);
            updateCaptureRegion("normal", normalRegionRef.current);
            restartRecognition();
            setError(localizationError instanceof Error ? localizationError.message : String(localizationError));
        }
    }

    function beginAutomaticLocalization(anchor: NormalizedRegion) {
        const currentSource = sourceDimensionsRef.current;
        if (!currentSource || !findLiveLootProfile(currentSource.width, currentSource.height, uiScaleRef.current))
            return;
        let nextSearch: NormalizedRegion;
        try {
            nextSearch = searchRegionAroundLootRegion(anchor, currentSource.width, currentSource.height);
        } catch (localizationError) {
            setError(localizationError instanceof Error ? localizationError.message : String(localizationError));
            return;
        }
        clearLocalization();
        restartRecognition();
        localizer.current = new NormalLootLocalizer();
        selectRegionKind("normal");
        updateRegion("normal", anchor);
        updateCaptureRegion("normal", null);
        updateSearchRegion(nextSearch);
        updatePlacementMode("localizing");
        updateRegionConfirmed(false);
        clearRegionPreview("normal");
        setError("");
    }

    function beginManualPlacement() {
        clearLocalization();
        restartRecognition();
        updateSearchRegion(null);
        updatePlacementMode("manual");
        updateRegionConfirmed(false);
        updateRareRegionConfirmed(false);
        updateCaptureRegion("normal", normalRegionRef.current);
        updateCaptureRegion("rare", rareRegionRef.current);
        clearRegionPreview("normal");
    }

    function releaseStream() {
        clearLocalization();
        stopRecognition();
        const captureToken = nativeCaptureToken.current;
        nativeCapture.current = false;
        nativeCaptureToken.current = null;
        if (captureToken !== null) void stopNativeDisplayCapture(captureToken);
        stopDisplayCapture(activeStream.current);
        activeStream.current = null;
        if (video.current) video.current.srcObject = null;
        setStatus("idle");
        setSavingRegion(false);
        setSampledFps(0);
        previewsEnabledRef.current = true;
        setPreviewsEnabled(true);
        setPreviewToggleBusy(false);
        setPreviewToggleError("");
        updateSourceDimensions(null);
        clearRegionPreview("normal");
        clearRegionPreview("rare");
        updateRegion("normal", null);
        updateRegion("rare", null);
        updateCaptureRegion("normal", null);
        updateCaptureRegion("rare", null);
        updateSearchRegion(null);
        updatePlacementMode("manual");
        updateRegionConfirmed(false);
        updateRareRegionConfirmed(false);
        sampledFrames.current = 0;
        lastNativeSampleBatch.current = 0;
        measurementStarted.current = performance.now();
        configuredSource.current = "";
        setNativeAppliedSelectionKey("");
    }

    function recordSample() {
        sampledFrames.current += 1;
        const now = performance.now();
        const elapsed = now - measurementStarted.current;
        if (elapsed < 1_000) return;
        if (diagnosticsVisible.current) setSampledFps((sampledFrames.current * 1_000) / elapsed);
        sampledFrames.current = 0;
        measurementStarted.current = now;
    }

    function stopCapture() {
        requestId.current += 1;
        releaseStream();
    }

    function togglePreviews() {
        setSetupOpen((open) => !open);
    }

    useEffect(() => {
        if (setupRequest === 0) return;
        setSetupOpen(true);
        video.current?.closest("section")?.scrollIntoView({ block: "start" });
        setupButton.current?.focus({ preventScroll: true });
    }, [setupRequest]);

    const previewsRequested = visible && windowVisible && setupOpen;
    useEffect(() => {
        previewsEnabledRef.current = previewsRequested;
        setPreviewsEnabled(previewsRequested);
        if (status !== "capturing") return;
        const token = nativeCaptureToken.current;
        if (token === null) return;
        let cancelled = false;
        setPreviewToggleBusy(true);
        setPreviewToggleError("");
        previewUpdates.current = previewUpdates.current
            .catch(() => undefined)
            .then(async () => {
                if (cancelled || token !== nativeCaptureToken.current) return;
                await setNativeDisplayCapturePreviewEnabled(token, previewsRequested);
            })
            .catch((error: unknown) => {
                if (!cancelled) setPreviewToggleError(String(error));
            })
            .finally(() => {
                if (!cancelled) setPreviewToggleBusy(false);
            });
        return () => {
            cancelled = true;
        };
    }, [previewsRequested, status]);

    useEffect(() => {
        if (regionConfirmed) {
            setSetupOpen(false);
            if (visible && windowVisible && setupOpen) setupButton.current?.focus();
        }
    }, [regionConfirmed]);

    useEffect(() => {
        onStatusChange(
            error || recognitionError
                ? "Capture needs attention"
                : status === "capturing"
                  ? recognitionStatus === "active"
                      ? "Tracking loot"
                      : "Capture setup"
                  : status === "idle"
                    ? "Capture off"
                    : "Connecting capture",
        );
    }, [error, recognitionError, recognitionStatus, status, onStatusChange]);

    async function toggleSampleCollection() {
        const captureToken = nativeCaptureToken.current;
        if (captureToken === null || sampleCollectionBusy) return;
        const revision = ++sampleCollectionRevision.current;
        setSampleCollectionBusy(true);
        setSampleCollectionError("");
        try {
            let next: DebugRoiSampleCollectionStatus;
            if (sampleCollection?.phase === "running") {
                next = await stopDebugRoiSampleCollection(captureToken);
            } else {
                let awaitedSelectionRevision: number;
                do {
                    awaitedSelectionRevision = nativeSelectionRevision.current;
                    await nativeSelectionUpdate.current;
                } while (awaitedSelectionRevision !== nativeSelectionRevision.current);
                next = await startDebugRoiSampleCollection(captureToken);
            }
            if (!mounted.current || revision !== sampleCollectionRevision.current) return;
            setSampleCollection(next);
            setSampleCollectionNow(Date.now());
        } catch (collectionError) {
            if (!mounted.current || revision !== sampleCollectionRevision.current) return;
            setSampleCollectionError(
                collectionError instanceof Error ? collectionError.message : String(collectionError),
            );
        } finally {
            if (mounted.current && revision === sampleCollectionRevision.current) setSampleCollectionBusy(false);
        }
    }

    async function startCapture() {
        setSetupOpen(true);
        if (!captureAllowed) return;
        stopCapture();
        setError("");
        const useNativeCapture = supportsNativeDisplayCapture();
        if (!useNativeCapture && !navigator.mediaDevices?.getDisplayMedia) {
            setError("This WebView does not support operating-system screen capture.");
            return;
        }

        const currentRequest = ++requestId.current;
        setStatus("requesting");
        let stream: MediaStream | null = null;
        try {
            if (useNativeCapture) {
                const captureToken = createNativeCaptureToken();
                nativeCapture.current = true;
                nativeCaptureToken.current = captureToken;
                receivedNativeFrame.current = false;
                await startNativeDisplayCapture(
                    captureToken,
                    null,
                    (frame) => {
                        if (!mounted.current || currentRequest !== requestId.current) return;
                        receivedNativeFrame.current = true;
                        setStatus("capturing");
                        if (lastNativeSampleBatch.current !== frame.batchId) {
                            lastNativeSampleBatch.current = frame.batchId;
                            recordSample();
                        }
                        const current = sourceDimensionsRef.current;
                        if (current?.width !== frame.sourceWidth || current.height !== frame.sourceHeight) {
                            updateSourceDimensions({ width: frame.sourceWidth, height: frame.sourceHeight });
                        }
                        if (frame.kind === "preview") {
                            if (previewsEnabledRef.current) drawFrame(canvas.current, frame);
                        } else if (frame.kind === "search-region") {
                            if (
                                placementModeRef.current !== "localizing" ||
                                !frameMatchesRegion(frame, searchRegionRef.current, sourceDimensionsRef.current)
                            )
                                return;
                            pushLocalizationFrame({
                                width: frame.width,
                                height: frame.height,
                                pixels: frame.pixels,
                                sourceWidth: frame.sourceWidth,
                                sourceHeight: frame.sourceHeight,
                                cropX: frame.cropX,
                                cropY: frame.cropY,
                            });
                        } else if (frame.kind === "region") {
                            if (placementModeRef.current === "localizing") return;
                            if (!frameMatchesRegion(frame, normalCaptureRegionRef.current, sourceDimensionsRef.current))
                                return;
                            setNormalRegionFrameSize((currentSize) =>
                                currentSize?.width === frame.width && currentSize.height === frame.height
                                    ? currentSize
                                    : { width: frame.width, height: frame.height },
                            );
                            if (previewsEnabledRef.current) drawFrame(normalRegionCanvas.current, frame);
                            if (regionIsReady("normal")) {
                                pushRecognitionFrame({
                                    width: frame.width,
                                    height: frame.height,
                                    pixels: frame.pixels,
                                });
                            }
                        } else {
                            if (placementModeRef.current === "localizing") return;
                            if (!frameMatchesRegion(frame, rareCaptureRegionRef.current, sourceDimensionsRef.current))
                                return;
                            setRareRegionFrameSize((currentSize) =>
                                currentSize?.width === frame.width && currentSize.height === frame.height
                                    ? currentSize
                                    : { width: frame.width, height: frame.height },
                            );
                            if (previewsEnabledRef.current) drawFrame(rareRegionCanvas.current, frame);
                            if (regionIsReady("rare")) {
                                pushRareRecognitionFrame({
                                    width: frame.width,
                                    height: frame.height,
                                    pixels: frame.pixels,
                                });
                            }
                        }
                    },
                    (message) => {
                        if (!mounted.current || currentRequest !== requestId.current) return;
                        requestId.current += 1;
                        releaseStream();
                        setError(message);
                    },
                );
                if (!mounted.current || currentRequest !== requestId.current) return;
                if (!receivedNativeFrame.current) setStatus("connecting");
                return;
            }

            stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CAPTURE_OPTIONS);
            if (!mounted.current || currentRequest !== requestId.current) {
                stopDisplayCapture(stream);
                return;
            }

            setStatus("connecting");
            const preview = video.current;
            if (!preview) throw new Error("The capture preview is unavailable.");
            activeStream.current = stream;
            preview.srcObject = stream;
            await preview.play();
            if (!mounted.current || currentRequest !== requestId.current) {
                stopDisplayCapture(stream);
                return;
            }
            stream.getVideoTracks()[0]?.addEventListener(
                "ended",
                () => {
                    if (!mounted.current || activeStream.current !== stream) return;
                    releaseStream();
                    setError("Screen sharing ended at the operating-system source.");
                },
                { once: true },
            );
            setStatus("capturing");
        } catch (captureError) {
            if (!mounted.current || currentRequest !== requestId.current) {
                stopDisplayCapture(stream);
                return;
            }
            if (nativeCapture.current) {
                const captureToken = nativeCaptureToken.current;
                nativeCapture.current = false;
                nativeCaptureToken.current = null;
                if (captureToken !== null) void stopNativeDisplayCapture(captureToken);
            }
            stopDisplayCapture(stream);
            activeStream.current = null;
            setStatus("idle");
            setError(displayCaptureErrorMessage(captureError));
        }
    }

    function moveRegion(event: ReactPointerEvent<HTMLDivElement>) {
        if (savingRegion) return;
        if (!sourceDimensions || !isSupportedLootSource(sourceDimensions.width, sourceDimensions.height)) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;
        const kind = activeRegionKindRef.current;
        const normalizedX = (event.clientX - bounds.left) / bounds.width;
        const normalizedY = (event.clientY - bounds.top) / bounds.height;
        const next = positionLootRegion(
            normalizedX,
            normalizedY,
            sourceDimensions.width,
            sourceDimensions.height,
            uiScaleRef.current,
            kind,
        );
        if (placementModeRef.current === "localizing" && kind === "normal") {
            localizer.current?.clear();
            localizer.current = new NormalLootLocalizer();
            pendingRecognitionFrames.current.length = 0;
            pendingRecognitionOverflowed.current = false;
            updateRegion("normal", next);
            updateCaptureRegion("normal", null);
            updateSearchRegion(
                positionLootSearchRegion(normalizedX, normalizedY, sourceDimensions.width, sourceDimensions.height),
            );
            updateRegionConfirmed(false);
            clearRegionPreview("normal");
            return;
        }
        const preserveAutomaticNormal = placementModeRef.current === "aligned" && kind === "rare";
        clearLocalization();
        restartRecognition();
        updateSearchRegion(null);
        if (!preserveAutomaticNormal) updatePlacementMode("manual");
        updateRegion(kind, next);
        updateCaptureRegion(kind, next);
        updateRegionConfirmed(false);
        if (kind === "rare") updateRareRegionConfirmed(false);
        clearRegionPreview(kind);
    }

    function changeUiScale(next: LootUiScale) {
        if (savingRegion) return;
        clearLocalization();
        restartRecognition();
        updateUiScale(next);
        updateRegionConfirmed(false);
        updateRareRegionConfirmed(false);
        const currentSource = sourceDimensionsRef.current;
        if (!currentSource || !isSupportedLootSource(currentSource.width, currentSource.height)) return;
        const reposition = (kind: LootRegionKind, current: NormalizedRegion | null) =>
            current
                ? positionLootRegion(
                      current.x + current.width / 2,
                      current.y + current.height / 2,
                      currentSource.width,
                      currentSource.height,
                      next,
                      kind,
                  )
                : defaultLootRegion(currentSource.width, currentSource.height, next, kind);
        const nextNormal = reposition("normal", normalRegionRef.current);
        const nextRare = reposition("rare", rareRegionRef.current);
        updateRegion("normal", nextNormal);
        updateRegion("rare", nextRare);
        updateCaptureRegion("rare", nextRare);
        if (findLiveLootProfile(currentSource.width, currentSource.height, next)) {
            localizer.current = new NormalLootLocalizer();
            selectRegionKind("normal");
            updateSearchRegion(searchRegionAroundLootRegion(nextNormal, currentSource.width, currentSource.height));
            updateCaptureRegion("normal", null);
            updatePlacementMode("localizing");
        } else {
            updateSearchRegion(null);
            updateCaptureRegion("normal", nextNormal);
            updatePlacementMode("manual");
        }
        clearRegionPreview("normal");
        clearRegionPreview("rare");
    }

    function changeSelectedRegion(next: NormalizedRegion) {
        if (savingRegion) return;
        const kind = activeRegionKindRef.current;
        if (placementModeRef.current !== "localizing") {
            const preserveAutomaticNormal = placementModeRef.current === "aligned" && kind === "rare";
            clearLocalization();
            restartRecognition();
            updateSearchRegion(null);
            if (!preserveAutomaticNormal) updatePlacementMode("manual");
            updateRegionConfirmed(false);
        }
        updateRegion(kind, next);
        updateCaptureRegion(kind, next);
        if (kind === "rare") updateRareRegionConfirmed(false);
        clearRegionPreview(kind);
    }

    function resetSelectedRegion() {
        const currentSource = sourceDimensionsRef.current;
        if (!currentSource || !isSupportedLootSource(currentSource.width, currentSource.height)) return;
        const kind = activeRegionKindRef.current;
        changeSelectedRegion(defaultLootRegion(currentSource.width, currentSource.height, uiScaleRef.current, kind));
    }

    function nudgeSelectedRegion(deltaX: number, deltaY: number) {
        const currentSource = sourceDimensionsRef.current;
        const kind = activeRegionKindRef.current;
        const current = kind === "normal" ? normalRegionRef.current : rareRegionRef.current;
        if (!currentSource || !current) return;
        changeSelectedRegion(
            nudgeLootRegion(
                current,
                deltaX,
                deltaY,
                currentSource.width,
                currentSource.height,
                uiScaleRef.current,
                kind,
            ),
        );
    }

    async function confirmRegion() {
        if (!sourceDimensions || !normalRegion || !rareRegion) return;
        const saveRequest = requestId.current;
        const settings = {
            region: normalRegion,
            rareRegion,
            rareRegionConfirmed: true,
            sourceWidth: sourceDimensions.width,
            sourceHeight: sourceDimensions.height,
            uiScalePercent,
        };
        updateCaptureRegion("normal", normalRegion);
        updateCaptureRegion("rare", rareRegion);
        setSavingRegion(true);
        setError("");
        try {
            const saved = await queueSettingsSave(settings);
            const currentSource = sourceDimensionsRef.current;
            if (
                saved &&
                currentSource?.width === settings.sourceWidth &&
                currentSource.height === settings.sourceHeight &&
                uiScaleRef.current === settings.uiScalePercent &&
                regionsEqual(normalRegionRef.current, settings.region) &&
                regionsEqual(rareRegionRef.current, settings.rareRegion)
            ) {
                updateRareRegionConfirmed(true);
                updateRegionConfirmed(true);
            }
        } finally {
            if (mounted.current && saveRequest === requestId.current) setSavingRegion(false);
        }
    }

    const calibratedProfile = sourceDimensions
        ? findLiveLootProfile(sourceDimensions.width, sourceDimensions.height, uiScalePercent)
        : null;
    const recognitionRequested =
        captureAllowed &&
        status === "capturing" &&
        calibratedProfile !== null &&
        (placementMode === "localizing" || placementMode === "aligned" || regionConfirmed || rareRegionConfirmed);
    useLayoutEffect(() => {
        recognitionRequestedRef.current = recognitionRequested;
    }, [recognitionRequested]);

    useLayoutEffect(() => {
        nextReviewResultId.current = 0;
        localizer.current?.clear();
        stopRecognition(false);
        clearReviewResults();
    }, [grindSpotId, sessionId]);

    useEffect(() => {
        stopRecognition(false);
        setRecognitionError("");
        ocrDiagnosticsRef.current = emptyOcrDiagnostics();
        setOcrDiagnostics(emptyOcrDiagnostics());
        if (!recognitionRequested || !calibratedProfile) {
            setRecognitionStatus(regionConfirmed && sourceDimensions && !calibratedProfile ? "unavailable" : "idle");
            return;
        }

        const generation = recognitionGeneration.current;
        setRecognitionStatus("starting");
        const previousStartup = recognitionStartup.current;
        // Tesseract setup cannot be aborted, so stale starts settle and terminate before a replacement begins.
        const startup = (async () => {
            if (previousStartup) await previousStartup.catch(() => undefined);
            if (!mounted.current || generation !== recognitionGeneration.current) return;
            let createdOcr: LiveLootTesseractOcr | null = null;
            try {
                const ocr = await createLiveLootTesseractOcr();
                createdOcr = ocr;
                if (!mounted.current || generation !== recognitionGeneration.current) {
                    await ocr.terminate();
                    return;
                }
                const readText = serializeLiveLootOcrReader(measuredOcrReader(ocr.readText, generation));
                const appendResult = (source: LiveLootReviewEntry["source"], result: LiveLootRecognitionResult) => {
                    if (
                        !mounted.current ||
                        activeSessionId.current !== sessionId ||
                        generation !== recognitionGeneration.current
                    )
                        return;
                    const id = nextReviewResultId.current;
                    nextReviewResultId.current += 1;
                    const pendingEntry: LiveLootReviewEntry = {
                        id,
                        source,
                        result,
                        accepted: false,
                        error: "",
                    };
                    const entry = acceptLiveLootReviewEntry(pendingEntry, onAcceptRecognitionRef.current);
                    const appended = appendLiveLootReviewResult(reviewResultsRef.current, entry);
                    reviewResultsRef.current = appended.results;
                    setReviewResults(appended.results);
                    const retainedIds = new Set(appended.results.map(({ id }) => id));
                    for (const reviewId of automaticRetries.current.keys()) {
                        if (!retainedIds.has(reviewId)) cancelAutomaticRetry(reviewId);
                    }
                    for (const reviewId of manualRetryAttempts.current.keys()) {
                        if (!retainedIds.has(reviewId)) manualRetryAttempts.current.delete(reviewId);
                    }
                    setRecognitionAnnouncement(resultAnnouncement(entry, AUTOMATIC_INSERTION_RETRY_DELAYS.length));
                    scheduleAutomaticRetry(entry, AUTOMATIC_INSERTION_RETRY_DELAYS.length);
                    if (appended.omittedCount > 0) {
                        setOmittedReviewResults((current) => current + appended.omittedCount);
                    }
                };
                const normalCoordinator = new LiveLootCoordinator({
                    profile: calibratedProfile.profile,
                    dictionary: itemDictionaryRef.current,
                    readText,
                    onResult: (result) => appendResult("normal", result),
                    maxPendingOcrJobs: NORMAL_MAX_OUTSTANDING_OCR_JOBS,
                });
                const rareAnalyzer = new RareLootFrameAnalyzer();
                const rareCoordinator = new LiveLootCoordinator({
                    profile: RARE_LOOT_PROFILE,
                    dictionary: itemDictionaryRef.current,
                    readText,
                    onResult: (result) => appendResult("rare", result),
                    maxPendingOcrJobs: RARE_MAX_OUTSTANDING_OCR_JOBS,
                    analyzeFrame: (frame) => rareAnalyzer.pushFrame(frame),
                    ocrSelection: RARE_LOOT_OCR_SELECTION,
                    ocrBounds: RARE_LOOT_OCR_BOUNDS,
                    ocrTextColor: "gold",
                    eventIdPrefix: "rare",
                });
                const pipeline = { normalCoordinator, rareCoordinator, ocr };
                recognition.current = pipeline;
                const replay = pendingLocalizationReplay.current.splice(0);
                const pending = pendingRecognitionFrames.current.splice(0);
                const pendingRare = pendingRareRecognitionFrames.current.splice(0);
                const overflowed = pendingRecognitionOverflowed.current;
                pendingRecognitionOverflowed.current = false;
                if (!overflowed) {
                    for (const frame of replay) {
                        if (recognition.current !== pipeline) break;
                        pushRecognitionFrame(frame);
                    }
                }
                for (const frame of pending) {
                    if (recognition.current !== pipeline) break;
                    pushRecognitionFrame(frame);
                }
                for (const frame of pendingRare) {
                    if (recognition.current !== pipeline) break;
                    pushRareRecognitionFrame(frame);
                }
                if (recognition.current === pipeline) setRecognitionStatus("active");
            } catch (setupError) {
                if (createdOcr) await createdOcr.terminate().catch(() => undefined);
                if (!mounted.current || generation !== recognitionGeneration.current) return;
                pendingLocalizationReplay.current.length = 0;
                pendingRecognitionFrames.current.length = 0;
                pendingRareRecognitionFrames.current.length = 0;
                pendingRecognitionOverflowed.current = false;
                setRecognitionStatus("error");
                setRecognitionError(setupError instanceof Error ? setupError.message : String(setupError));
            }
        })();
        recognitionStartup.current = startup;
        void startup
            .finally(() => {
                if (recognitionStartup.current === startup) recognitionStartup.current = null;
            })
            .catch(() => undefined);

        return () => {
            if (generation === recognitionGeneration.current) stopRecognition(false);
        };
    }, [calibratedProfile, grindSpotId, recognitionRequested, recognitionReset, sessionId, sourceDimensions]);

    useEffect(() => {
        if (recognitionStatus !== "active" || !diagnosticsOpen || !visible || !windowVisible) return;
        const publish = () => {
            const pipeline = recognition.current;
            recordOutstandingOcrJobs("normal", pipeline?.normalCoordinator.pendingOcrJobCount ?? 0);
            recordOutstandingOcrJobs("rare", pipeline?.rareCoordinator.pendingOcrJobCount ?? 0);
            publishOcrDiagnostics();
        };
        publish();
        const timer = window.setInterval(publish, 1_000);
        return () => window.clearInterval(timer);
    }, [recognitionStatus, diagnosticsOpen, visible, windowVisible]);

    useEffect(() => {
        if (!supportsTauriApi()) return;
        let cancelled = false;
        void loadLootCaptureSettings()
            .then((settings) => {
                if (!cancelled) setSavedSettings(settings);
            })
            .catch((settingsError) => {
                if (!cancelled)
                    setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
            })
            .finally(() => {
                if (!cancelled) setSettingsLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!sourceDimensions || !settingsLoaded) return;
        const sourceKey = `${sourceDimensions.width}x${sourceDimensions.height}`;
        if (configuredSource.current === sourceKey) return;
        configuredSource.current = sourceKey;
        clearLocalization();
        clearRegionPreview("normal");
        clearRegionPreview("rare");
        updateRareRegionConfirmed(false);
        if (!isSupportedLootSource(sourceDimensions.width, sourceDimensions.height)) {
            updateRegion("normal", null);
            updateRegion("rare", null);
            updateCaptureRegion("normal", null);
            updateCaptureRegion("rare", null);
            updateSearchRegion(null);
            updatePlacementMode("manual");
            updateRegionConfirmed(false);
            return;
        }

        let selectedScale = uiScaleRef.current;
        let selectedNormal = defaultLootRegion(
            sourceDimensions.width,
            sourceDimensions.height,
            selectedScale,
            "normal",
        );
        let selectedRare = defaultLootRegion(sourceDimensions.width, sourceDimensions.height, selectedScale, "rare");
        let confirmed = false;
        let rareConfirmed = false;
        if (
            savedSettings?.sourceWidth === sourceDimensions.width &&
            savedSettings.sourceHeight === sourceDimensions.height
        ) {
            selectedScale = savedSettings.uiScalePercent;
            selectedNormal = defaultLootRegion(
                sourceDimensions.width,
                sourceDimensions.height,
                selectedScale,
                "normal",
            );
            selectedRare = defaultLootRegion(sourceDimensions.width, sourceDimensions.height, selectedScale, "rare");
            let normalValid = false;
            let rareValid = false;
            try {
                const pixels = normalizedRegionToPixels(
                    savedSettings.region,
                    sourceDimensions.width,
                    sourceDimensions.height,
                );
                const expected = lootRegionSize(selectedScale, "normal");
                if (pixels.width === expected.width && pixels.height === expected.height) {
                    selectedNormal = savedSettings.region;
                    normalValid = true;
                }
            } catch {
                normalValid = false;
            }
            if (savedSettings.rareRegion) {
                try {
                    const pixels = normalizedRegionToPixels(
                        savedSettings.rareRegion,
                        sourceDimensions.width,
                        sourceDimensions.height,
                    );
                    const expected = lootRegionSize(selectedScale, "rare");
                    if (pixels.width === expected.width && pixels.height === expected.height) {
                        selectedRare = savedSettings.rareRegion;
                        rareValid = true;
                    }
                } catch {
                    rareValid = false;
                }
            }
            rareConfirmed = rareValid && savedSettings.rareRegionConfirmed;
            confirmed = normalValid && rareConfirmed;
        }
        updateUiScale(selectedScale);
        updateRegion("normal", selectedNormal);
        updateRegion("rare", selectedRare);
        updateCaptureRegion("rare", selectedRare);
        updateRareRegionConfirmed(rareConfirmed);
        if (findLiveLootProfile(sourceDimensions.width, sourceDimensions.height, selectedScale)) {
            beginAutomaticLocalization(selectedNormal);
        } else {
            updateSearchRegion(null);
            updateCaptureRegion("normal", selectedNormal);
            updatePlacementMode("manual");
            updateRegionConfirmed(confirmed);
        }
    }, [savedSettings, settingsLoaded, sourceDimensions]);

    useEffect(() => {
        if (status !== "capturing" || !nativeCapture.current) return;
        const currentRequest = requestId.current;
        const captureToken = nativeCaptureToken.current;
        if (captureToken === null) return;
        let selection: NativeCaptureSelection | null = null;
        if (placementMode === "localizing" && searchRegion && sourceDimensions && calibratedProfile) {
            const searchPixels = normalizedRegionToPixels(
                searchRegion,
                sourceDimensions.width,
                sourceDimensions.height,
            );
            if (
                searchPixels.width === LOOT_SEARCH_REGION_SIZE.width &&
                searchPixels.height === LOOT_SEARCH_REGION_SIZE.height
            ) {
                selection = {
                    mode: "search",
                    region: searchRegion,
                    sourceWidth: sourceDimensions.width,
                    sourceHeight: sourceDimensions.height,
                    uiScalePercent: 80,
                };
            }
        } else if (placementMode !== "localizing") {
            selection = regionsCaptureSelection(
                normalCaptureRegion,
                rareCaptureRegion,
                sourceDimensions,
                uiScalePercent,
                rareRegionConfirmed,
            );
        }
        const selectionKey = JSON.stringify(selection);
        const selectionRevision = ++nativeSelectionRevision.current;
        const update = nativeSelectionUpdate.current
            .catch(() => undefined)
            .then(async () => {
                if (
                    !mounted.current ||
                    currentRequest !== requestId.current ||
                    !nativeCapture.current ||
                    selectionRevision !== nativeSelectionRevision.current
                )
                    return;
                await setNativeDisplayCaptureRegion(captureToken, selection);
                if (
                    mounted.current &&
                    currentRequest === requestId.current &&
                    selectionRevision === nativeSelectionRevision.current
                ) {
                    setNativeAppliedSelectionKey(selectionKey);
                }
            });
        nativeSelectionUpdate.current = update;
        void update.catch((regionError) => {
            if (
                !mounted.current ||
                currentRequest !== requestId.current ||
                selectionRevision !== nativeSelectionRevision.current
            )
                return;
            setError(regionError instanceof Error ? regionError.message : String(regionError));
        });
    }, [
        calibratedProfile,
        normalCaptureRegion,
        placementMode,
        rareCaptureRegion,
        rareRegionConfirmed,
        regionConfirmed,
        searchRegion,
        sourceDimensions,
        status,
        uiScalePercent,
    ]);

    useEffect(() => {
        if (!sessionActive) {
            clearAutomaticRetries();
            if (status !== "idle") stopCapture();
        }
    }, [sessionActive, status]);

    useEffect(() => {
        if (
            !debugSampleCollectionAvailable ||
            sampleCollectionBusy ||
            (sampleCollection?.phase !== "running" && sampleCollection?.phase !== "finalizing")
        )
            return;
        let cancelled = false;
        let timer = 0;
        const revision = sampleCollectionRevision.current;
        const refresh = async () => {
            setSampleCollectionNow(Date.now());
            try {
                const next = await debugRoiSampleCollectionStatus();
                if (cancelled || revision !== sampleCollectionRevision.current) return;
                setSampleCollection(next);
                setSampleCollectionError("");
                if (next.phase === "running" || next.phase === "finalizing") {
                    timer = window.setTimeout(() => void refresh(), 1_000);
                }
            } catch (collectionError) {
                if (cancelled || revision !== sampleCollectionRevision.current) return;
                setSampleCollectionError(
                    collectionError instanceof Error ? collectionError.message : String(collectionError),
                );
                timer = window.setTimeout(() => void refresh(), 1_000);
            }
        };
        timer = window.setTimeout(() => void refresh(), 1_000);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [debugSampleCollectionAvailable, sampleCollection?.phase, sampleCollectionBusy]);

    useEffect(() => {
        if (status !== "capturing" || nativeCapture.current) return;
        let lastVideoTime = -1;
        const timer = window.setInterval(() => {
            const preview = video.current;
            const output = canvas.current;
            if (!preview || !output || preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
            if (preview.currentTime === lastVideoTime || preview.videoWidth === 0 || preview.videoHeight === 0) return;

            lastVideoTime = preview.currentTime;
            const scale = Math.min(1, 640 / preview.videoWidth);
            const width = Math.max(1, Math.round(preview.videoWidth * scale));
            const height = Math.max(1, Math.round(preview.videoHeight * scale));
            if (previewsEnabledRef.current) {
                if (output.width !== width || output.height !== height) {
                    output.width = width;
                    output.height = height;
                }
                output.getContext("2d")?.drawImage(preview, 0, 0, width, height);
            }
            const currentSource = sourceDimensionsRef.current;
            const sourceChanged =
                currentSource?.width !== preview.videoWidth || currentSource.height !== preview.videoHeight;
            if (sourceChanged) {
                clearLocalization();
                updateSourceDimensions({ width: preview.videoWidth, height: preview.videoHeight });
                clearRegionPreview("normal");
                clearRegionPreview("rare");
            }
            if (!sourceChanged && isSupportedLootSource(preview.videoWidth, preview.videoHeight)) {
                const localizingAtSampleStart = placementModeRef.current === "localizing";
                if (localizingAtSampleStart) {
                    const selectedSearch = searchRegionRef.current;
                    if (selectedSearch) {
                        try {
                            const pixels = normalizedRegionToPixels(
                                selectedSearch,
                                preview.videoWidth,
                                preview.videoHeight,
                            );
                            if (
                                pixels.width === LOOT_SEARCH_REGION_SIZE.width &&
                                pixels.height === LOOT_SEARCH_REGION_SIZE.height
                            ) {
                                const searchCanvas = searchRegionCanvas.current ?? document.createElement("canvas");
                                searchRegionCanvas.current = searchCanvas;
                                if (
                                    searchCanvas.width !== LOOT_SEARCH_REGION_SIZE.width ||
                                    searchCanvas.height !== LOOT_SEARCH_REGION_SIZE.height
                                ) {
                                    searchCanvas.width = LOOT_SEARCH_REGION_SIZE.width;
                                    searchCanvas.height = LOOT_SEARCH_REGION_SIZE.height;
                                }
                                const searchContext = searchCanvas.getContext("2d");
                                searchContext?.drawImage(
                                    preview,
                                    pixels.x,
                                    pixels.y,
                                    LOOT_SEARCH_REGION_SIZE.width,
                                    LOOT_SEARCH_REGION_SIZE.height,
                                    0,
                                    0,
                                    LOOT_SEARCH_REGION_SIZE.width,
                                    LOOT_SEARCH_REGION_SIZE.height,
                                );
                                if (searchContext) {
                                    const frame = searchContext.getImageData(
                                        0,
                                        0,
                                        LOOT_SEARCH_REGION_SIZE.width,
                                        LOOT_SEARCH_REGION_SIZE.height,
                                    );
                                    pushLocalizationFrame({
                                        width: LOOT_SEARCH_REGION_SIZE.width,
                                        height: LOOT_SEARCH_REGION_SIZE.height,
                                        pixels: frame.data,
                                        sourceWidth: preview.videoWidth,
                                        sourceHeight: preview.videoHeight,
                                        cropX: pixels.x,
                                        cropY: pixels.y,
                                    });
                                }
                            }
                        } catch (frameError) {
                            clearLocalization();
                            restartRecognition();
                            updateSearchRegion(null);
                            updatePlacementMode("manual");
                            updateRegionConfirmed(false);
                            updateCaptureRegion("normal", normalRegionRef.current);
                            setError(frameError instanceof Error ? frameError.message : String(frameError));
                        }
                    }
                }
                const drawBrowserRegion = (kind: LootRegionKind) => {
                    if (localizingAtSampleStart) return;
                    const selected = kind === "normal" ? normalRegionRef.current : rareRegionRef.current;
                    let crop: HTMLCanvasElement | null;
                    if (previewsEnabledRef.current) {
                        crop = kind === "normal" ? normalRegionCanvas.current : rareRegionCanvas.current;
                    } else {
                        const pausedCrop = kind === "normal" ? pausedNormalRegionCanvas : pausedRareRegionCanvas;
                        crop = pausedCrop.current ?? document.createElement("canvas");
                        pausedCrop.current = crop;
                    }
                    if (!selected || !crop) return;
                    const pixels = normalizedRegionToPixels(selected, preview.videoWidth, preview.videoHeight);
                    if (crop.width !== pixels.width || crop.height !== pixels.height) {
                        crop.width = pixels.width;
                        crop.height = pixels.height;
                    }
                    const cropContext = crop.getContext("2d");
                    cropContext?.drawImage(
                        preview,
                        pixels.x,
                        pixels.y,
                        pixels.width,
                        pixels.height,
                        0,
                        0,
                        pixels.width,
                        pixels.height,
                    );
                    if (cropContext && regionIsReady(kind)) {
                        try {
                            const frame = cropContext.getImageData(0, 0, pixels.width, pixels.height);
                            const recognitionFrame = { width: pixels.width, height: pixels.height, pixels: frame.data };
                            if (kind === "normal") pushRecognitionFrame(recognitionFrame);
                            else pushRareRecognitionFrame(recognitionFrame);
                        } catch (frameError) {
                            stopRecognition(false);
                            setRecognitionStatus("error");
                            setRecognitionError(frameError instanceof Error ? frameError.message : String(frameError));
                        }
                    }
                    const setFrameSize = kind === "normal" ? setNormalRegionFrameSize : setRareRegionFrameSize;
                    setFrameSize((current) =>
                        current?.width === pixels.width && current.height === pixels.height
                            ? current
                            : { width: pixels.width, height: pixels.height },
                    );
                };
                drawBrowserRegion("normal");
                drawBrowserRegion("rare");
            }
            recordSample();
        }, 125);
        return () => window.clearInterval(timer);
    }, [status]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            requestId.current += 1;
            clearAutomaticRetries();
            clearLocalization();
            stopRecognition(false);
            stopDisplayCapture(activeStream.current);
            const captureToken = nativeCaptureToken.current;
            if (captureToken !== null) void stopNativeDisplayCapture(captureToken);
        };
    }, []);

    const sourceSupported = sourceDimensions
        ? isSupportedLootSource(sourceDimensions.width, sourceDimensions.height)
        : false;
    const sourceSize = sourceDimensions
        ? `${sourceDimensions.width} x ${sourceDimensions.height}`
        : "Reading dimensions...";
    const normalRegionPixels =
        normalRegion && sourceDimensions
            ? normalizedRegionToPixels(normalRegion, sourceDimensions.width, sourceDimensions.height)
            : null;
    const rareRegionPixels =
        rareRegion && sourceDimensions
            ? normalizedRegionToPixels(rareRegion, sourceDimensions.width, sourceDimensions.height)
            : null;
    const searchRegionPixels =
        searchRegion && sourceDimensions
            ? normalizedRegionToPixels(searchRegion, sourceDimensions.width, sourceDimensions.height)
            : null;
    const expectedRegionSize = lootRegionSize(uiScalePercent, activeRegionKind);
    const normalGuideFrameSize = lootRegionSize(uiScalePercent, "normal");
    const rareGuideFrameSize = lootRegionSize(uiScalePercent, "rare");
    const normalAlignmentGuide = lootAlignmentGuide(uiScalePercent, "normal");
    const rareAlignmentGuide = lootAlignmentGuide(uiScalePercent, "rare");
    const normalRecognitionReady = calibratedProfile !== null && (placementMode === "aligned" || regionConfirmed);
    const rareRecognitionReady = calibratedProfile !== null && rareRegionConfirmed;
    const sampleCaptureSelection =
        placementMode === "localizing"
            ? null
            : regionsCaptureSelection(
                  normalCaptureRegion,
                  rareCaptureRegion,
                  sourceDimensions,
                  uiScalePercent,
                  rareRegionConfirmed,
              );
    const sampleCollectionActive = sampleCollection?.phase === "running";
    const sampleCollectionFinalizing = sampleCollection?.phase === "finalizing";
    const sampleCollectionReady =
        nativeCapture.current &&
        normalCaptureRegion !== null &&
        rareCaptureRegion !== null &&
        (placementMode === "aligned" || regionConfirmed) &&
        rareRegionConfirmed &&
        normalRegionFrameSize !== null &&
        rareRegionFrameSize !== null &&
        nativeAppliedSelectionKey === JSON.stringify(sampleCaptureSelection);
    const placementLabel = !calibratedProfile
        ? "No calibrated profile"
        : placementMode === "localizing"
          ? "Searching for loot notification"
          : placementMode === "aligned"
            ? "Auto-aligned"
            : "Manual placement";
    const recognitionLabel = !calibratedProfile
        ? "No calibrated profile"
        : recognitionStatus === "starting"
          ? "Starting local OCR..."
          : recognitionStatus === "active"
            ? "Local OCR active"
            : recognitionStatus === "error"
              ? "Recognition stopped"
              : placementMode === "manual" && !regionConfirmed
                ? "Confirm manual placement"
                : "Waiting";
    const placementConfirmationInstruction = regionConfirmed
        ? "Both areas are confirmed."
        : placementMode === "aligned"
          ? "Confirm the rare area to enable rare recognition."
          : "Confirm after placing both.";
    const calibrationInstruction = !previewsEnabled
        ? "Resume live previews to adjust capture placement or UI scale."
        : placementMode === "localizing"
          ? "Waiting for at least two stacked loot notifications. Drag the 800 x 600 auto-search area to recenter the search if needed."
          : `Drag the selected ${expectedRegionSize.width} x ${expectedRegionSize.height} area. ${
                activeRegionKind === "normal"
                    ? "Each green horizontal line should run through the center of a visible item name."
                    : "The green horizontal line should run through the center of the rare item name. Rare recognition is provisional."
            } ${placementConfirmationInstruction}`;

    return {
        setupButton,
        setupOpen,
        diagnosticsOpen,
        setDiagnosticsOpen,
        video,
        status,
        previewToggleBusy,
        togglePreviews,
        previewsEnabled,
        stopCapture,
        captureAllowed,
        startCapture,
        databaseLoaded,
        sessionStatus,
        error,
        previewToggleError,
        recognitionError,
        previewsEnabledRef,
        savingRegion,
        draggingRegion,
        placementModeRef,
        activeRegionKindRef,
        updateCaptureRegion,
        moveRegion,
        normalRegionRef,
        rareRegionRef,
        canvas,
        sourceSupported,
        placementMode,
        searchRegion,
        activeRegionKind,
        normalRegion,
        normalGuideFrameSize,
        normalAlignmentGuide,
        rareRegion,
        rareRecognitionReady,
        rareGuideFrameSize,
        rareAlignmentGuide,
        sourceDimensions,
        selectRegionKind,
        calibrationInstruction,
        beginManualPlacement,
        resetSelectedRegion,
        nudgeSelectedRegion,
        uiScalePercent,
        changeUiScale,
        calibratedProfile,
        beginAutomaticLocalization,
        regionConfirmed,
        confirmRegion,
        sourceSize,
        sampledFps,
        placementLabel,
        searchRegionPixels,
        normalRegionPixels,
        normalRecognitionReady,
        normalRegionFrameSize,
        rareRegionPixels,
        rareRegionFrameSize,
        recognitionStatus,
        recognitionLabel,
        ocrDiagnostics,
        NORMAL_MAX_OUTSTANDING_OCR_JOBS,
        RARE_MAX_OUTSTANDING_OCR_JOBS,
        formatOcrDuration,
        grindSpotName,
        itemDictionary,
        debugSampleCollectionAvailable,
        sampleCollectionBusy,
        sampleCollectionFinalizing,
        sampleCollectionActive,
        sampleCollectionReady,
        toggleSampleCollection,
        sampleCollection,
        formatSampleCollectionBytes,
        formatSampleCollectionCountdown,
        sampleCollectionNow,
        sampleCollectionError,
        normalRegionCanvas,
        rareRegionCanvas,
        recognitionAnnouncement,
        reviewResults,
        clearReviewResults,
        omittedReviewResults,
        resultDescription,
        acceptReviewResult,
    };
}
