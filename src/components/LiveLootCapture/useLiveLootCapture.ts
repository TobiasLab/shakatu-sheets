import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    type LootCaptureSettings,
    loadLootCaptureSettings,
    type NativeCaptureCapabilities,
    type NativeCaptureFrame,
    type NativeCaptureSelection,
    nativeCaptureCapabilities,
    readNormalLootLayout,
    saveLootCaptureSettings,
    setNativeDisplayCapturePreviewEnabled,
    setNativeDisplayCaptureRegion,
    startNativeDisplayCapture,
    stopNativeDisplayCapture,
    supportsTauriApi,
} from "../../api/tauri";
import { isActiveSessionStatus, type SessionStatus } from "../../domain/session";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
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
    positionNormalLootFromLayout,
    searchRegionAroundLootRegion,
    stopDisplayCapture,
} from "../../recognition/displayCapture";
import {
    LiveLootCoordinator,
    type LiveLootOcrReader,
    type LiveLootRecognitionResult,
    type LootRoiFrame,
    NORMAL_LOOT_OCR_SELECTION,
} from "../../recognition/liveLoot";
import { type LootSearchFrame, NormalLootLocalizer } from "../../recognition/liveLootLocalization";
import {
    createLiveLootTesseractOcr,
    type LiveLootTesseractOcr,
    serializeLiveLootOcrReader,
} from "../../recognition/liveLootOcr";
import {
    findLiveLootProfile,
    findRareLootGeometry,
    supportsAutomaticLootLocalization,
} from "../../recognition/liveLootProfiles";
import type { LiveLootReviewEntry } from "../../recognition/liveLootReview";
import { LIVE_LOOT_SAMPLE_FPS } from "../../recognition/lootCaptureTiming";
import type { LootFont } from "../../recognition/lootFont";
import { suggestUnresolvedQuantity } from "../../recognition/quantityLearning";
import { RARE_LOOT_OCR_SELECTION, RareLootFrameAnalyzer, rareLootDetectionProfile } from "../../recognition/rareLoot";
import { RareLootLocalizer } from "../../recognition/rareLootLocalization";
import { RoiOcrDiagnostics, roiOcrFailure } from "../../recognition/roiOcrDiagnostics";
import {
    formatSampleCollectionBytes,
    formatSampleCollectionCountdown,
    useDebugSampleCollection,
} from "./useDebugSampleCollection";
import { resultDescription, useLiveLootReviewQueue } from "./useLiveLootReviewQueue";

type CaptureStatus = "idle" | "requesting" | "connecting" | "capturing";
type RecognitionStatus = "idle" | "starting" | "active" | "unavailable" | "error";
type PlacementMode = "localizing" | "aligned" | "manual";
type SourceDimensions = { width: number; height: number };
type RecognitionPipeline = {
    normalDiagnostics: RoiOcrDiagnostics;
    rareDiagnostics: RoiOcrDiagnostics;
    normalCoordinator: LiveLootCoordinator;
    rareCoordinator: LiveLootCoordinator;
    /** A fresh rare coordinator with diagnostics that number frames from zero, as the coordinator does. */
    createRareRecognition: () => { rareCoordinator: LiveLootCoordinator; rareDiagnostics: RoiOcrDiagnostics };
    ocr: LiveLootTesseractOcr;
};
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
export type CaptureSummary = { label: string; tone: "active" | "error" | "idle"; pendingReviews: number };

export type LiveLootCaptureProps = {
    learning: ReturnType<typeof useSelfImprovement>;
    onOpenSelfImprovement: () => void;
    lootFont: LootFont;
    lootFontReady: boolean;
    setupRequest: number;
    visible: boolean;
    onStatusChange: (status: CaptureSummary) => void;
    databaseLoaded: boolean;
    sessionId: string;
    sessionStatus: SessionStatus;
    grindSpotId: string;
    grindSpotName: string;
    itemDictionary: readonly string[];
    onAcceptRecognition: (itemName: string, quantity: number, source?: "manual" | "recognition") => string | null;
};

const MAX_PENDING_RECOGNITION_FRAMES = 64;
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
    font: LootFont,
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
            font,
            region: normalRegion,
            rareRegion,
            rareRegionConfirmed,
            sourceWidth: source.width,
            sourceHeight: source.height,
            uiScalePercent,
        },
    };
}

export function useLiveLootCapture({
    lootFont,
    lootFontReady,
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
    learning,
    onOpenSelfImprovement,
}: LiveLootCaptureProps) {
    const closingRecognition = useRef(false);
    const [captureFont, setCaptureFont] = useState<LootFont>("korean");
    const windowVisible = useWindowVisible();
    const [setupOpen, setSetupOpen] = useState(false);
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const diagnosticsRequested = setupOpen && diagnosticsOpen && visible && windowVisible;
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
        diagnosticsVisible.current = diagnosticsRequested;
    }, [diagnosticsRequested]);
    const measurementStarted = useRef(performance.now());
    const requestId = useRef(0);
    const nativeSelectionUpdate = useRef<Promise<void>>(Promise.resolve());
    const nativeSelectionRevision = useRef(0);
    const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
    const nextSettingsSaveId = useRef(0);
    const mounted = useRef(true);
    const activeSessionId = useRef(sessionId);
    const draggingRegion = useRef(false);
    const dragGuideOffset = useRef({ x: 0, y: 0 });
    const activeRegionKindRef = useRef<LootRegionKind>("normal");
    const configuredSource = useRef("");
    const normalRegionRef = useRef<NormalizedRegion | null>(null);
    const rareRegionRef = useRef<NormalizedRegion | null>(null);
    const placementModeRef = useRef<PlacementMode>("manual");
    const searchRegionRef = useRef<NormalizedRegion | null>(null);
    const normalRegionConfirmedRef = useRef(false);
    const normalPlacementAfterSearch = useRef<{ mode: "manual" | "aligned"; confirmed: boolean }>({
        mode: "manual",
        confirmed: false,
    });
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
    const pendingLocalizationReplay = useRef<LootRoiFrame[]>([]);
    const pendingRecognitionFrames = useRef<LootRoiFrame[]>([]);
    const pendingRareRecognitionFrames = useRef<LootRoiFrame[]>([]);
    const pendingRecognitionOverflowed = useRef(false);
    const localizer = useRef<NormalLootLocalizer | RareLootLocalizer | null>(null);
    const itemDictionaryRef = useRef(itemDictionary);
    const [status, setStatus] = useState<CaptureStatus>("idle");
    const [error, setError] = useState("");
    const [sampledFps, setSampledFps] = useState(0);
    const [previewsEnabled, setPreviewsEnabled] = useState(true);
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
    const [normalRegionConfirmed, setNormalRegionConfirmed] = useState(false);
    const [rareRegionConfirmed, setRareRegionConfirmed] = useState(false);
    const normalRegionReady = placementMode === "aligned" || normalRegionConfirmed;
    const regionConfirmed = normalRegionReady && rareRegionConfirmed;
    const [persistingRegion, setSavingRegion] = useState(false);
    const [importingLayout, setImportingLayout] = useState(false);
    const [layoutImportMessage, setLayoutImportMessage] = useState("");
    const layoutImportBusy = useRef(false);
    const savingRegion = persistingRegion || importingLayout;
    const [recognitionStatus, setRecognitionStatus] = useState<RecognitionStatus>("idle");
    const [recognitionError, setRecognitionError] = useState("");
    const [recognitionReset, setRecognitionReset] = useState(0);
    const [ocrDiagnostics, setOcrDiagnostics] = useState<OcrDiagnostics>(emptyOcrDiagnostics);
    const [nativeAppliedSelectionKey, setNativeAppliedSelectionKey] = useState("");
    const [captureCapabilities, setCaptureCapabilities] = useState<NativeCaptureCapabilities | null>(null);
    const lastNativeArrival = useRef<number | null>(null);
    const [sourceWaiting, setSourceWaiting] = useState(false);
    const captureSessionId = useRef(sessionId);
    const samples = useDebugSampleCollection({
        candidate: import.meta.env.DEV && captureCapabilities?.debugRoiSamples === true,
        font: captureFont,
        nativeCaptureToken,
        waitForNativeSelection,
    });
    useEffect(() => {
        let cancelled = false;
        void nativeCaptureCapabilities()
            .then((capabilities) => {
                if (!cancelled) setCaptureCapabilities(capabilities);
            })
            .catch((failure) => {
                if (!cancelled) setError(`Could not check capture support: ${String(failure)}`);
            });
        return () => {
            cancelled = true;
        };
    }, []);
    useLayoutEffect(() => {
        if (captureSessionId.current !== sessionId) {
            captureSessionId.current = sessionId;
            stopCapture();
        }
    }, [sessionId]);
    const sessionActive = isActiveSessionStatus(sessionStatus);
    const review = useLiveLootReviewQueue({ sessionId, sessionActive, databaseLoaded, learning, onAcceptRecognition });
    const captureAllowed = databaseLoaded && sessionActive && captureCapabilities !== null;

    useLayoutEffect(() => {
        activeSessionId.current = sessionId;
        itemDictionaryRef.current = itemDictionary;
    }, [itemDictionary, sessionId]);

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

    function updateNormalRegionConfirmed(next: boolean) {
        normalRegionConfirmedRef.current = next;
        setNormalRegionConfirmed(next);
    }

    /** Ends an automatic search. A rare-banner search only paused the loot stack, so its placement comes back. */
    function restoreNormalPlacement() {
        updatePlacementMode(normalPlacementAfterSearch.current.mode);
        updateNormalRegionConfirmed(normalPlacementAfterSearch.current.confirmed);
    }

    function updateRareRegionConfirmed(next: boolean) {
        if (rareRegionConfirmedRef.current !== next) setNativeAppliedSelectionKey("");
        rareRegionConfirmedRef.current = next;
        setRareRegionConfirmed(next);
    }

    function regionIsReady(kind: LootRegionKind) {
        return kind === "normal"
            ? placementModeRef.current === "aligned" || normalRegionConfirmedRef.current
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
        if (closingRecognition.current) return;
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
            current.normalDiagnostics.observe(frame);
            current.normalCoordinator.pushFrame(frame);
            recordFrameAnalysis(started);
            recordOutstandingOcrJobs("normal", current.normalCoordinator.pendingOcrJobCount);
        } catch (frameError) {
            current.normalDiagnostics.frameFailure(frameError);
            stopRecognition(false);
            setRecognitionStatus("error");
            setRecognitionError(frameError instanceof Error ? frameError.message : String(frameError));
        }
    }

    function pushRareRecognitionFrame(frame: LootRoiFrame) {
        if (closingRecognition.current) return;
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
            current.rareDiagnostics.observe(frame);
            current.rareCoordinator.pushFrame(frame);
            recordFrameAnalysis(started);
            recordOutstandingOcrJobs("rare", current.rareCoordinator.pendingOcrJobCount);
        } catch (frameError) {
            current.rareDiagnostics.frameFailure(frameError);
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

    function restartRareRecognition() {
        pendingRareRecognitionFrames.current.length = 0;
        const current = recognition.current;
        if (!current) return;
        current.rareCoordinator.stop();
        const next = current.createRareRecognition();
        current.rareCoordinator = next.rareCoordinator;
        current.rareDiagnostics = next.rareDiagnostics;
        recordOutstandingOcrJobs("rare", 0);
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

    function createLocalizer() {
        return activeRegionKindRef.current === "rare"
            ? new RareLootLocalizer(uiScaleRef.current, LIVE_LOOT_SAMPLE_FPS)
            : new NormalLootLocalizer(uiScaleRef.current, LIVE_LOOT_SAMPLE_FPS);
    }

    function lockAutomaticLocalization(region: NormalizedRegion, replayFrames: LootRoiFrame[]) {
        const currentSource = sourceDimensionsRef.current;
        if (
            placementModeRef.current !== "localizing" ||
            !currentSource ||
            !supportsAutomaticLootLocalization(currentSource.width, currentSource.height, uiScaleRef.current)
        )
            return;

        if (activeRegionKindRef.current === "rare") {
            clearLocalization();
            updateSearchRegion(null);
            updateRegion("rare", region);
            updateCaptureRegion("rare", region);
            restoreNormalPlacement();
            updateRareRegionConfirmed(false);
            clearRegionPreview("rare");
            return;
        }
        localizer.current = null;
        updateSearchRegion(null);
        updateRegion("normal", region);
        updateCaptureRegion("normal", region);
        updatePlacementMode("aligned");
        updateNormalRegionConfirmed(false);
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

    function pushLocalizationFrame(frame: LootSearchFrame) {
        if (closingRecognition.current) return;
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
            restoreNormalPlacement();
            updateCaptureRegion("normal", normalRegionRef.current);
            updateCaptureRegion("rare", rareRegionRef.current);
            restartRecognition();
            setError(localizationError instanceof Error ? localizationError.message : String(localizationError));
        }
    }

    function beginAutomaticLocalization() {
        const kind = activeRegionKindRef.current;
        const anchor = kind === "normal" ? normalRegionRef.current : rareRegionRef.current;
        if (!anchor) return;
        const currentSource = sourceDimensionsRef.current;
        if (
            !currentSource ||
            !supportsAutomaticLootLocalization(currentSource.width, currentSource.height, uiScaleRef.current)
        )
            return;
        let nextSearch: NormalizedRegion;
        try {
            nextSearch = searchRegionAroundLootRegion(
                anchor,
                currentSource.width,
                currentSource.height,
                kind,
                uiScaleRef.current,
            );
        } catch (localizationError) {
            setError(localizationError instanceof Error ? localizationError.message : String(localizationError));
            return;
        }
        normalPlacementAfterSearch.current =
            kind === "rare"
                ? {
                      mode: placementModeRef.current === "aligned" ? "aligned" : "manual",
                      confirmed: normalRegionConfirmedRef.current,
                  }
                : { mode: "manual", confirmed: false };
        clearLocalization();
        restartRecognition();
        localizer.current = createLocalizer();
        updateRegion(kind, anchor);
        updateCaptureRegion(kind, null);
        if (kind === "rare") updateRareRegionConfirmed(false);
        updateSearchRegion(nextSearch);
        updatePlacementMode("localizing");
        updateNormalRegionConfirmed(false);
        clearRegionPreview(kind);
        setError("");
    }

    function beginManualPlacement() {
        clearLocalization();
        restartRecognition();
        updateSearchRegion(null);
        restoreNormalPlacement();
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
        samples.forgetSampleCollection();
        if (captureToken !== null) void stopNativeDisplayCapture(captureToken);
        stopDisplayCapture(activeStream.current);
        activeStream.current = null;
        if (video.current) video.current.srcObject = null;
        setStatus("idle");
        setSavingRegion(false);
        setSampledFps(0);
        previewsEnabledRef.current = true;
        setPreviewsEnabled(true);
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
        updateNormalRegionConfirmed(false);
        updateRareRegionConfirmed(false);
        sampledFrames.current = 0;
        lastNativeSampleBatch.current = 0;
        lastNativeArrival.current = null;
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

    async function prepareReview() {
        const captureRequest = requestId.current;
        const reviewSession = activeSessionId.current;
        try {
            await recognitionStartup.current;
            if (!mounted.current || activeSessionId.current !== reviewSession || requestId.current !== captureRequest)
                return null;
            closingRecognition.current = true;
            const pipeline = recognition.current;
            if (pipeline) await Promise.all([pipeline.normalCoordinator.finish(), pipeline.rareCoordinator.finish()]);
            if (!mounted.current || activeSessionId.current !== reviewSession || requestId.current !== captureRequest)
                return null;
            return review.unacceptedReviewCount();
        } finally {
            if (mounted.current && activeSessionId.current === reviewSession && requestId.current === captureRequest)
                stopCapture();
        }
    }

    function stopCapture() {
        setLayoutImportMessage("");
        closingRecognition.current = false;
        requestId.current += 1;
        releaseStream();
    }

    useEffect(() => {
        const stop = () => stopCapture();
        window.addEventListener("shakatu-stop-capture", stop);
        return () => window.removeEventListener("shakatu-stop-capture", stop);
    }, []);

    useEffect(() => {
        const expectsFrames =
            previewsEnabled || (nativeAppliedSelectionKey !== "" && nativeAppliedSelectionKey !== "null");
        // Native sources send no frames while the screen is static or the game is minimized; show that as waiting.
        if (!captureCapabilities?.backend || status !== "capturing" || !windowVisible || !expectsFrames) {
            setSourceWaiting(false);
            return;
        }
        const update = () =>
            setSourceWaiting(
                lastNativeArrival.current !== null && performance.now() - lastNativeArrival.current > 2_000,
            );
        update();
        const timer = window.setInterval(update, 1_000);
        return () => window.clearInterval(timer);
    }, [captureCapabilities, status, windowVisible, previewsEnabled, nativeAppliedSelectionKey]);

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
        setPreviewToggleError("");
        previewUpdates.current = previewUpdates.current
            .catch(() => undefined)
            .then(async () => {
                if (cancelled || token !== nativeCaptureToken.current) return;
                await setNativeDisplayCapturePreviewEnabled(token, previewsRequested);
            })
            .catch((error: unknown) => {
                if (!cancelled) setPreviewToggleError(String(error));
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

    /** Resolves once the most recently requested native crop selection has been applied. */
    async function waitForNativeSelection() {
        let awaitedSelectionRevision: number;
        do {
            awaitedSelectionRevision = nativeSelectionRevision.current;
            await nativeSelectionUpdate.current;
        } while (awaitedSelectionRevision !== nativeSelectionRevision.current);
    }

    async function startCapture() {
        setSetupOpen(true);
        if (!captureAllowed || !lootFontReady) return;
        stopCapture();
        setCaptureFont(lootFont);
        setError("");
        const useNativeCapture = captureCapabilities?.backend != null;
        if (useNativeCapture && !captureCapabilities?.available) {
            setError(captureCapabilities?.reason ?? "Native capture is unavailable on this device.");
            return;
        }
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
                        const arrival = performance.now();
                        // A Windows window source pauses only while minimized, so rows still on screen afterwards are treated
                        // as already counted. Linux captures the whole monitor and gets frames only when it changes, so the
                        // first frame after a pause may show a new drop and recognition continues.
                        if (
                            captureCapabilities?.backend === "windows" &&
                            lastNativeArrival.current !== null &&
                            arrival - lastNativeArrival.current > 2_000
                        ) {
                            if (placementModeRef.current === "localizing") localizer.current = createLocalizer();
                            restartRecognition();
                        }
                        lastNativeArrival.current = arrival;
                        receivedNativeFrame.current = true;
                        setStatus("capturing");
                        if (lastNativeSampleBatch.current !== frame.batchId) {
                            lastNativeSampleBatch.current = frame.batchId;
                            recordSample();
                        }
                        const current = sourceDimensionsRef.current;
                        if (current?.width !== frame.sourceWidth || current.height !== frame.sourceHeight) {
                            stopRecognition();
                            if (captureCapabilities?.backend === "windows") {
                                updateNormalRegionConfirmed(false);
                                updateRareRegionConfirmed(false);
                            }
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
                                    sample: samples.sampleReference(frame.batchId),
                                    captureBatch: { captureToken, batchId: frame.batchId },
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
                                    sample: samples.sampleReference(frame.batchId),
                                    captureBatch: { captureToken, batchId: frame.batchId },
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
                samples.forgetSampleCollection();
                if (captureToken !== null) void stopNativeDisplayCapture(captureToken);
            }
            stopDisplayCapture(stream);
            activeStream.current = null;
            setStatus("idle");
            setError(displayCaptureErrorMessage(captureError));
        }
    }

    async function importNormalLootLayout(file: File | undefined) {
        const source = sourceDimensionsRef.current;
        if (!file || savingRegion || layoutImportBusy.current || !source || !previewsEnabledRef.current) return;
        const captureRequest = requestId.current;
        const scale = uiScaleRef.current;
        const stillCurrent = () =>
            mounted.current &&
            captureRequest === requestId.current &&
            source === sourceDimensionsRef.current &&
            scale === uiScaleRef.current &&
            previewsEnabledRef.current;
        layoutImportBusy.current = true;
        setImportingLayout(true);
        setLayoutImportMessage("");
        try {
            if (file.size > 2 * 1024 * 1024) throw new Error("The settings file is too large (maximum 2 MiB).");
            const position = await readNormalLootLayout(await file.text());
            if (!stillCurrent()) return;
            if (position.uiScalePercent !== scale) {
                throw new Error(
                    `This file uses ${position.uiScalePercent}% UI scale. Select that scale in capture setup before importing.`,
                );
            }
            const next = positionNormalLootFromLayout(position.x, position.y, source.width, source.height, scale);
            clearLocalization();
            restartRecognition();
            updateSearchRegion(null);
            updatePlacementMode("manual");
            selectRegionKind("normal");
            updateRegion("normal", next);
            updateCaptureRegion("normal", next);
            updateNormalRegionConfirmed(false);
            clearRegionPreview("normal");
            setError("");
            setLayoutImportMessage(
                "Normal area moved to the saved layout position. Check the item-name rows in the preview, adjust if needed, then confirm both areas.",
            );
        } catch (failure) {
            if (stillCurrent()) setLayoutImportMessage(failure instanceof Error ? failure.message : String(failure));
        } finally {
            layoutImportBusy.current = false;
            if (mounted.current) setImportingLayout(false);
        }
    }

    function beginRegionDrag(event: ReactPointerEvent<HTMLDivElement>) {
        dragGuideOffset.current = { x: 0, y: 0 };
        if (placementModeRef.current === "localizing") return;
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-loot-region]");
        const selected = target?.dataset.lootRegion;
        if (selected === "normal" || selected === "rare") selectRegionKind(selected);
        const source = sourceDimensionsRef.current;
        const kind = activeRegionKindRef.current;
        const region = kind === "normal" ? normalRegionRef.current : rareRegionRef.current;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (!source || !region || !bounds.width || !bounds.height) return;
        const guide = lootAlignmentGuide(uiScaleRef.current, kind);
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        const left = region.x + guide.x / source.width;
        const top = region.y + guide.y / source.height;
        if (
            target ||
            (x >= left && x <= left + guide.width / source.width && y >= top && y <= top + guide.height / source.height)
        ) {
            dragGuideOffset.current = {
                x: x - left - guide.width / source.width / 2,
                y: y - top - guide.height / source.height / 2,
            };
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
        const localizing = placementModeRef.current === "localizing";
        const next = positionLootRegion(
            normalizedX - (localizing ? 0 : dragGuideOffset.current.x),
            normalizedY - (localizing ? 0 : dragGuideOffset.current.y),
            sourceDimensions.width,
            sourceDimensions.height,
            uiScaleRef.current,
            kind,
        );
        if (placementModeRef.current === "localizing") {
            localizer.current?.clear();
            localizer.current = createLocalizer();
            pendingRecognitionFrames.current.length = 0;
            pendingRecognitionOverflowed.current = false;
            updateRegion(kind, next);
            updateCaptureRegion(kind, null);
            updateSearchRegion(
                positionLootSearchRegion(normalizedX, normalizedY, sourceDimensions.width, sourceDimensions.height),
            );
            updateNormalRegionConfirmed(false);
            clearRegionPreview(kind);
            return;
        }
        if (kind === "rare") {
            restartRareRecognition();
            updateRareRegionConfirmed(false);
        } else {
            clearLocalization();
            restartRecognition();
            updateSearchRegion(null);
            updatePlacementMode("manual");
            updateNormalRegionConfirmed(false);
        }
        updateRegion(kind, next);
        updateCaptureRegion(kind, next);
        clearRegionPreview(kind);
    }

    function changeUiScale(next: LootUiScale) {
        if (savingRegion) return;
        clearLocalization();
        restartRecognition();
        updateUiScale(next);
        updateNormalRegionConfirmed(false);
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
        updateSearchRegion(null);
        updateCaptureRegion("normal", nextNormal);
        updatePlacementMode("manual");
        clearRegionPreview("normal");
        clearRegionPreview("rare");
    }

    function changeSelectedRegion(next: NormalizedRegion) {
        if (savingRegion) return;
        const kind = activeRegionKindRef.current;
        if (kind === "rare") {
            restartRareRecognition();
            updateRareRegionConfirmed(false);
        } else if (placementModeRef.current !== "localizing") {
            clearLocalization();
            restartRecognition();
            updateSearchRegion(null);
            updatePlacementMode("manual");
            updateNormalRegionConfirmed(false);
        }
        updateRegion(kind, next);
        updateCaptureRegion(kind, next);
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
            font: captureFont,
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
                updateNormalRegionConfirmed(true);
            }
        } finally {
            if (mounted.current && saveRequest === requestId.current) setSavingRegion(false);
        }
    }

    const automaticLocalizationAvailable = sourceDimensions
        ? supportsAutomaticLootLocalization(sourceDimensions.width, sourceDimensions.height, uiScalePercent)
        : false;
    const calibratedProfile = sourceDimensions
        ? findLiveLootProfile(sourceDimensions.width, sourceDimensions.height, uiScalePercent)
        : null;
    const displayedRecognitionStatus = sourceDimensions && !calibratedProfile ? "unavailable" : recognitionStatus;
    const pendingReviews = review.reviewResults.filter((entry) => !entry.accepted).length;
    useEffect(() => {
        const failed = Boolean(error || recognitionError);
        onStatusChange({
            label: failed
                ? "Capture needs attention"
                : status === "capturing"
                  ? displayedRecognitionStatus === "active"
                      ? "Tracking loot"
                      : displayedRecognitionStatus === "unavailable"
                        ? "Capture preview only"
                        : displayedRecognitionStatus === "starting"
                          ? "Starting recognition"
                          : "Capture setup"
                  : status === "idle"
                    ? "Capture off"
                    : "Connecting capture",
            tone: failed
                ? "error"
                : status === "capturing" && displayedRecognitionStatus === "active"
                  ? "active"
                  : "idle",
            pendingReviews,
        });
    }, [error, recognitionError, displayedRecognitionStatus, status, pendingReviews, onStatusChange]);

    const rareGeometry = sourceDimensions
        ? findRareLootGeometry(sourceDimensions.width, sourceDimensions.height, uiScalePercent)
        : null;
    const recognitionRequested =
        captureAllowed &&
        status === "capturing" &&
        calibratedProfile !== null &&
        ((placementMode === "localizing" && activeRegionKind === "normal") ||
            placementMode === "aligned" ||
            normalRegionConfirmed ||
            rareRegionConfirmed);
    useLayoutEffect(() => {
        recognitionRequestedRef.current = recognitionRequested;
    }, [recognitionRequested]);

    useLayoutEffect(() => {
        localizer.current?.clear();
        stopRecognition(false);
        review.resetReviewResults();
    }, [grindSpotId, sessionId]);

    useEffect(() => {
        stopRecognition(false);
        setRecognitionError("");
        ocrDiagnosticsRef.current = emptyOcrDiagnostics();
        setOcrDiagnostics(emptyOcrDiagnostics());
        if (!recognitionRequested || !calibratedProfile || !rareGeometry) {
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
                const ocr = await createLiveLootTesseractOcr({ font: captureFont });
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
                    review.addReviewResult({
                        source,
                        font: captureFont,
                        learningId: crypto.randomUUID(),
                        learningContext: { sessionId, generation },
                        learningProfile: sourceDimensions
                            ? {
                                  font: captureFont,
                                  uiScalePercent: calibratedProfile.capture.uiScalePercent,
                                  sourceWidth: sourceDimensions.width,
                                  sourceHeight: sourceDimensions.height,
                              }
                            : undefined,
                        result,
                    });
                };
                const normalDiagnostics = new RoiOcrDiagnostics("normal", generation, samples.emitOcrIssue);
                const normalCoordinator = new LiveLootCoordinator({
                    font: captureFont,
                    sampleFps: LIVE_LOOT_SAMPLE_FPS,
                    ocrSelection: NORMAL_LOOT_OCR_SELECTION,
                    profile: calibratedProfile.profile,
                    dictionary: itemDictionaryRef.current,
                    readText: normalDiagnostics.wrap(readText),
                    suggestQuantity: (frames, readings) =>
                        sourceDimensions
                            ? suggestUnresolvedQuantity(
                                  frames,
                                  readings,
                                  itemDictionaryRef.current,
                                  {
                                      font: captureFont,
                                      uiScalePercent: calibratedProfile.capture.uiScalePercent,
                                      sourceWidth: sourceDimensions.width,
                                      sourceHeight: sourceDimensions.height,
                                  },
                                  learning.model.current,
                              )
                            : undefined,
                    onResult: (result) => {
                        normalDiagnostics.result(result);
                        appendResult("normal", result);
                    },
                    maxPendingOcrJobs: NORMAL_MAX_OUTSTANDING_OCR_JOBS,
                });
                const createRareRecognition = () => {
                    const rareDiagnostics = new RoiOcrDiagnostics("rare", generation, samples.emitOcrIssue);
                    const rareAnalyzer = new RareLootFrameAnalyzer(rareGeometry, LIVE_LOOT_SAMPLE_FPS);
                    const rareCoordinator = new LiveLootCoordinator({
                        font: captureFont,
                        sampleFps: LIVE_LOOT_SAMPLE_FPS,
                        profile: rareLootDetectionProfile(rareGeometry),
                        dictionary: itemDictionaryRef.current,
                        readText: rareDiagnostics.wrap(readText),
                        onResult: (result) => {
                            rareDiagnostics.result(result);
                            appendResult("rare", result);
                        },
                        maxPendingOcrJobs: RARE_MAX_OUTSTANDING_OCR_JOBS,
                        analyzeFrame: (frame) => rareAnalyzer.pushFrame(frame),
                        ocrSelection: RARE_LOOT_OCR_SELECTION,
                        ocrBounds: rareGeometry.ocrBounds,
                        ocrTextColor: "gold",
                        eventIdPrefix: "rare",
                    });
                    return { rareCoordinator, rareDiagnostics };
                };
                const pipeline = {
                    normalCoordinator,
                    normalDiagnostics,
                    ...createRareRecognition(),
                    createRareRecognition,
                    ocr,
                };
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
                for (const [source, frames] of [
                    ["normal", pendingRecognitionFrames.current],
                    ["rare", pendingRareRecognitionFrames.current],
                ] as const) {
                    const sample = [...frames].reverse().find((frame) => frame.sample)?.sample;
                    if (sample)
                        samples.emitOcrIssue(
                            roiOcrFailure(sample, source, generation, "ocr-startup-failure", setupError),
                        );
                }
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
    }, [
        calibratedProfile,
        captureFont,
        grindSpotId,
        recognitionRequested,
        recognitionReset,
        sessionId,
        sourceDimensions,
    ]);

    useEffect(() => {
        if (recognitionStatus !== "active" || !diagnosticsRequested) return;
        const publish = () => {
            const pipeline = recognition.current;
            recordOutstandingOcrJobs("normal", pipeline?.normalCoordinator.pendingOcrJobCount ?? 0);
            recordOutstandingOcrJobs("rare", pipeline?.rareCoordinator.pendingOcrJobCount ?? 0);
            publishOcrDiagnostics();
        };
        publish();
        const timer = window.setInterval(publish, 1_000);
        return () => window.clearInterval(timer);
    }, [recognitionStatus, diagnosticsRequested]);

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
            updateNormalRegionConfirmed(false);
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
            rareConfirmed =
                captureCapabilities?.backend !== "windows" && rareValid && savedSettings.rareRegionConfirmed;
            confirmed = normalValid && rareConfirmed;
        }
        updateUiScale(selectedScale);
        updateRegion("normal", selectedNormal);
        updateRegion("rare", selectedRare);
        updateCaptureRegion("rare", selectedRare);
        updateRareRegionConfirmed(rareConfirmed);
        updateSearchRegion(null);
        updateCaptureRegion("normal", selectedNormal);
        updatePlacementMode("manual");
        updateNormalRegionConfirmed(confirmed);
    }, [savedSettings, settingsLoaded, sourceDimensions]);

    useEffect(() => {
        if (status !== "capturing" || !nativeCapture.current) return;
        const currentRequest = requestId.current;
        const captureToken = nativeCaptureToken.current;
        if (captureToken === null) return;
        let selection: NativeCaptureSelection | null = null;
        if (placementMode === "localizing" && searchRegion && sourceDimensions && automaticLocalizationAvailable) {
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
                    uiScalePercent,
                };
            }
        } else if (placementMode !== "localizing") {
            selection = regionsCaptureSelection(
                normalCaptureRegion,
                rareCaptureRegion,
                sourceDimensions,
                uiScalePercent,
                rareRegionConfirmed,
                captureFont,
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
        automaticLocalizationAvailable,
        captureFont,
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

    useLayoutEffect(() => {
        if (!sessionActive) {
            stopRecognition(false);
            review.clearReviewResults();
        }
    }, [sessionActive]);

    useEffect(() => {
        if (!sessionActive) {
            review.clearAutomaticRetries();
            if (status !== "idle") stopCapture();
        }
    }, [sessionActive, status]);

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
                            restoreNormalPlacement();
                            updateCaptureRegion("normal", normalRegionRef.current);
                            updateCaptureRegion("rare", rareRegionRef.current);
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
        }, 1000 / LIVE_LOOT_SAMPLE_FPS);
        return () => window.clearInterval(timer);
    }, [status]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            requestId.current += 1;
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
    const normalGuideFrameSize = lootRegionSize(uiScalePercent, "normal");
    const rareGuideFrameSize = lootRegionSize(uiScalePercent, "rare");
    const normalAlignmentGuide = lootAlignmentGuide(uiScalePercent, "normal");
    const rareAlignmentGuide = lootAlignmentGuide(uiScalePercent, "rare");
    const normalRecognitionReady = calibratedProfile !== null && normalRegionReady;
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
                  captureFont,
              );
    const sampleCollectionActive = samples.sampleCollection?.phase === "running";
    const sampleCollectionFinalizing = samples.sampleCollection?.phase === "finalizing";
    const sampleCollectionReady =
        nativeCapture.current &&
        normalCaptureRegion !== null &&
        rareCaptureRegion !== null &&
        regionConfirmed &&
        normalRegionFrameSize !== null &&
        rareRegionFrameSize !== null &&
        nativeAppliedSelectionKey === JSON.stringify(sampleCaptureSelection);
    const placementLabel =
        placementMode === "localizing"
            ? activeRegionKind === "rare"
                ? "Searching for rare banner"
                : "Searching for loot notification"
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
        : normalRegionReady
          ? "Confirm the rare area to enable rare recognition."
          : "Confirm after placing both.";
    const calibrationInstruction = !previewsEnabled
        ? "Resume live previews to adjust capture placement or UI scale."
        : placementMode === "localizing"
          ? activeRegionKind === "rare"
              ? "Waiting for a rare gold banner. Drag the 800 x 600 auto-search area around the banner if needed. Confirm the rare area after automatic adjustment."
              : "Waiting for at least two stacked loot notifications. Drag the 800 x 600 auto-search area to recenter the search if needed."
          : `Drag the green ${activeRegionKind === "normal" ? "loot stack" : "rare loot"} box, or click the preview to place it. Use the arrows for one-pixel adjustments. ${
                activeRegionKind === "normal"
                    ? "Each green horizontal line should run through the center of a visible item name."
                    : "The green horizontal line should run through the center of the rare item name. Rare recognition is provisional."
            } ${placementConfirmationInstruction}`;

    return {
        learning,
        onOpenSelfImprovement,
        setupButton,
        setupOpen,
        diagnosticsOpen,
        setDiagnosticsOpen,
        video,
        status,
        togglePreviews,
        previewsEnabled,
        stopCapture,
        captureAllowed: captureAllowed && lootFontReady,
        captureBackend: captureCapabilities?.backend,
        sourceWaiting,
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
        beginRegionDrag,
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
        importNormalLootLayout,
        importingLayout,
        layoutImportMessage,
        calibratedProfile,
        automaticLocalizationAvailable,
        beginAutomaticLocalization,
        normalRegionReady,
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
        recognitionStatus: displayedRecognitionStatus,
        recognitionLabel,
        ocrDiagnostics,
        NORMAL_MAX_OUTSTANDING_OCR_JOBS,
        RARE_MAX_OUTSTANDING_OCR_JOBS,
        formatOcrDuration,
        grindSpotName,
        itemDictionary,
        debugSampleCollectionAvailable: samples.debugSampleCollectionAvailable,
        sampleCollectionBusy: samples.sampleCollectionBusy,
        sampleCollectionFinalizing,
        sampleCollectionActive,
        sampleCollectionReady,
        toggleSampleCollection: samples.toggleSampleCollection,
        sampleCollection: samples.sampleCollection,
        formatSampleCollectionBytes,
        formatSampleCollectionCountdown,
        sampleCollectionNow: samples.sampleCollectionNow,
        sampleCollectionError: samples.sampleCollectionError,
        normalRegionCanvas,
        rareRegionCanvas,
        recognitionAnnouncement: review.recognitionAnnouncement,
        reviewResults: review.reviewResults,
        clearReviewResults: review.clearReviewResults,
        dismissReviewResult: review.dismissReviewResult,
        prepareReview,
        omittedReviewResults: review.omittedReviewResults,
        resultDescription,
        acceptReviewResult: review.acceptReviewResult,
        correctReviewResult: review.correctReviewResult,
    };
}
