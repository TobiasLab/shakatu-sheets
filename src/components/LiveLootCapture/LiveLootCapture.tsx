import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import {
    type LootCaptureSettings,
    loadLootCaptureSettings,
    type NativeCaptureFrame,
    saveLootCaptureSettings,
    setNativeDisplayCaptureRegion,
    startNativeDisplayCapture,
    stopNativeDisplayCapture,
    supportsNativeDisplayCapture,
    supportsTauriApi,
} from "../../api/tauri";
import type { SessionStatus } from "../../domain/session";
import {
    DISPLAY_CAPTURE_OPTIONS,
    defaultLootRegion,
    displayCaptureErrorMessage,
    isSupportedLootSource,
    type LootAlignmentGuide,
    type LootRegionKind,
    type LootUiScale,
    lootAlignmentGuide,
    lootRegionSize,
    type NormalizedRegion,
    normalizedRegionToPixels,
    nudgeLootRegion,
    positionLootRegion,
    stopDisplayCapture,
} from "../../recognition/displayCapture";
import { LiveLootCoordinator, type LiveLootRecognitionResult, type LootRoiFrame } from "../../recognition/liveLoot";
import { createLiveLootTesseractOcr, type LiveLootTesseractOcr } from "../../recognition/liveLootOcr";
import { findLiveLootProfile } from "../../recognition/liveLootProfiles";
import {
    acceptLiveLootReviewEntry,
    appendLiveLootReviewResult,
    type LiveLootReviewEntry,
} from "../../recognition/liveLootReview";
import styles from "./LiveLootCapture.module.css";

type CaptureStatus = "idle" | "requesting" | "connecting" | "capturing";
type RecognitionStatus = "idle" | "starting" | "active" | "unavailable" | "error";
type SourceDimensions = { width: number; height: number };
type RecognitionPipeline = {
    coordinator: LiveLootCoordinator;
    ocr: LiveLootTesseractOcr;
};
type AutomaticRetry = { timerId: number; retriesRemaining: number };
type LiveLootCaptureProps = {
    sessionId: string;
    sessionStatus: SessionStatus;
    grindSpotName: string;
    itemDictionary: readonly string[];
    onAcceptRecognition: (itemName: string, quantity: number) => string | null;
};

const AUTOMATIC_INSERTION_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

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

function AlignmentGuide({ frameSize, guide }: { frameSize: SourceDimensions; guide: LootAlignmentGuide }) {
    return (
        <div
            className={styles.RecognitionGuide}
            aria-hidden="true"
            style={{
                left: `${(guide.x / frameSize.width) * 100}%`,
                top: `${(guide.y / frameSize.height) * 100}%`,
                width: `${(guide.width / frameSize.width) * 100}%`,
                height: `${(guide.height / frameSize.height) * 100}%`,
            }}
        >
            <span className={styles.GuideLabel}>Align loot text</span>
            {guide.rowCenters.map((center) => (
                <i
                    key={center}
                    style={{
                        top: `${((center - guide.y) / guide.height) * 100}%`,
                    }}
                />
            ))}
        </div>
    );
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

function resultDescription(result: LiveLootRecognitionResult) {
    if (result.status === "recognized") return `${result.itemName} x ${result.quantity}`;
    if (result.status === "failed") return "Local OCR failed for this notification.";
    if (result.status === "dropped") return `${result.count} notifications dropped while recognition was busy.`;
    if (result.reason === "insufficient-observations") return "Notification disappeared before three stable frames.";
    if (result.reason === "item-not-recognized") return "OCR item did not match the active grind spot.";
    if (result.reason === "quantity-not-recognized") return "OCR did not find a stable quantity suffix.";
    return "No item and quantity pair reached consensus.";
}

export function LiveLootCapture({
    sessionId,
    sessionStatus,
    grindSpotName,
    itemDictionary,
    onAcceptRecognition,
}: LiveLootCaptureProps) {
    const video = useRef<HTMLVideoElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const normalRegionCanvas = useRef<HTMLCanvasElement>(null);
    const rareRegionCanvas = useRef<HTMLCanvasElement>(null);
    const activeStream = useRef<MediaStream | null>(null);
    const nativeCapture = useRef(false);
    const receivedNativeFrame = useRef(false);
    const sampledFrames = useRef(0);
    const measurementStarted = useRef(performance.now());
    const requestId = useRef(0);
    const nativeSelectionUpdate = useRef<Promise<void>>(Promise.resolve());
    const mounted = useRef(true);
    const sessionRunning = useRef(sessionStatus === "running");
    const previousSessionRunning = useRef(sessionStatus === "running");
    const sessionRunGeneration = useRef(0);
    const activeSessionId = useRef(sessionId);
    const draggingRegion = useRef(false);
    const activeRegionKindRef = useRef<LootRegionKind>("normal");
    const configuredSource = useRef("");
    const normalRegionRef = useRef<NormalizedRegion | null>(null);
    const rareRegionRef = useRef<NormalizedRegion | null>(null);
    const normalCaptureRegionRef = useRef<NormalizedRegion | null>(null);
    const rareCaptureRegionRef = useRef<NormalizedRegion | null>(null);
    const sourceDimensionsRef = useRef<SourceDimensions | null>(null);
    const uiScaleRef = useRef<LootUiScale>(80);
    const recognition = useRef<RecognitionPipeline | null>(null);
    const recognitionGeneration = useRef(0);
    const recognitionStartup = useRef<Promise<void> | null>(null);
    const nextReviewResultId = useRef(0);
    const reviewResultsRef = useRef<LiveLootReviewEntry[]>([]);
    const automaticRetries = useRef(new Map<number, AutomaticRetry>());
    const itemDictionaryRef = useRef(itemDictionary);
    const onAcceptRecognitionRef = useRef(onAcceptRecognition);
    const [status, setStatus] = useState<CaptureStatus>("idle");
    const [error, setError] = useState("");
    const [sampledFps, setSampledFps] = useState(0);
    const [sourceDimensions, setSourceDimensions] = useState<SourceDimensions | null>(null);
    const [normalRegionFrameSize, setNormalRegionFrameSize] = useState<SourceDimensions | null>(null);
    const [rareRegionFrameSize, setRareRegionFrameSize] = useState<SourceDimensions | null>(null);
    const [savedSettings, setSavedSettings] = useState<LootCaptureSettings | null>(null);
    const [settingsLoaded, setSettingsLoaded] = useState(() => !supportsTauriApi());
    const [normalRegion, setNormalRegion] = useState<NormalizedRegion | null>(null);
    const [rareRegion, setRareRegion] = useState<NormalizedRegion | null>(null);
    const [normalCaptureRegion, setNormalCaptureRegion] = useState<NormalizedRegion | null>(null);
    const [rareCaptureRegion, setRareCaptureRegion] = useState<NormalizedRegion | null>(null);
    const [activeRegionKind, setActiveRegionKind] = useState<LootRegionKind>("normal");
    const [uiScalePercent, setUiScalePercent] = useState<LootUiScale>(80);
    const [regionConfirmed, setRegionConfirmed] = useState(false);
    const [savingRegion, setSavingRegion] = useState(false);
    const [recognitionStatus, setRecognitionStatus] = useState<RecognitionStatus>("idle");
    const [recognitionError, setRecognitionError] = useState("");
    const [reviewResults, setReviewResults] = useState<LiveLootReviewEntry[]>([]);
    const [omittedReviewResults, setOmittedReviewResults] = useState(0);

    const isSessionRunning = sessionStatus === "running";
    if (previousSessionRunning.current && !isSessionRunning) sessionRunGeneration.current += 1;
    previousSessionRunning.current = isSessionRunning;
    sessionRunning.current = isSessionRunning;
    activeSessionId.current = sessionId;
    itemDictionaryRef.current = itemDictionary;
    onAcceptRecognitionRef.current = onAcceptRecognition;

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
            normalCaptureRegionRef.current = next;
            setNormalCaptureRegion(next);
        } else {
            rareCaptureRegionRef.current = next;
            setRareCaptureRegion(next);
        }
    }

    function selectRegionKind(kind: LootRegionKind) {
        activeRegionKindRef.current = kind;
        setActiveRegionKind(kind);
    }

    function clearRegionPreview(kind: LootRegionKind) {
        if (kind === "normal") {
            setNormalRegionFrameSize(null);
            clearCanvas(normalRegionCanvas.current);
        } else {
            setRareRegionFrameSize(null);
            clearCanvas(rareRegionCanvas.current);
        }
    }

    function updateSourceDimensions(next: SourceDimensions | null) {
        sourceDimensionsRef.current = next;
        setSourceDimensions(next);
    }

    function updateUiScale(next: LootUiScale) {
        uiScaleRef.current = next;
        setUiScalePercent(next);
    }

    function stopRecognition(updateStatus = true) {
        recognitionGeneration.current += 1;
        const current = recognition.current;
        recognition.current = null;
        current?.coordinator.stop();
        if (current) void current.ocr.terminate().catch(() => undefined);
        if (updateStatus && mounted.current) setRecognitionStatus("idle");
    }

    function pushRecognitionFrame(frame: LootRoiFrame) {
        const current = recognition.current;
        if (!current) return;
        try {
            current.coordinator.pushFrame(frame);
        } catch (frameError) {
            stopRecognition(false);
            setRecognitionStatus("error");
            setRecognitionError(frameError instanceof Error ? frameError.message : String(frameError));
        }
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

    function replaceReviewEntry(entry: LiveLootReviewEntry) {
        let retained = false;
        const next = reviewResultsRef.current.map((candidate) => {
            if (candidate.id !== entry.id) return candidate;
            retained = true;
            return entry;
        });
        if (!retained) return;
        reviewResultsRef.current = next;
        setReviewResults(next);
    }

    function scheduleAutomaticRetry(entry: LiveLootReviewEntry, retriesRemaining: number) {
        if (entry.accepted || entry.result.status !== "recognized" || retriesRemaining < 1) return;
        cancelAutomaticRetry(entry.id);
        const retrySessionId = activeSessionId.current;
        const retrySessionRunGeneration = sessionRunGeneration.current;
        const delayIndex = AUTOMATIC_INSERTION_RETRY_DELAYS.length - retriesRemaining;
        const timerId = window.setTimeout(() => {
            const pending = automaticRetries.current.get(entry.id);
            if (!pending || pending.timerId !== timerId) return;
            automaticRetries.current.delete(entry.id);
            if (
                !mounted.current ||
                !sessionRunning.current ||
                activeSessionId.current !== retrySessionId ||
                sessionRunGeneration.current !== retrySessionRunGeneration
            )
                return;
            const current = reviewResultsRef.current.find((candidate) => candidate.id === entry.id) ?? entry;
            const retried = acceptLiveLootReviewEntry(current, onAcceptRecognitionRef.current);
            replaceReviewEntry(retried);
            scheduleAutomaticRetry(retried, retriesRemaining - 1);
        }, AUTOMATIC_INSERTION_RETRY_DELAYS[delayIndex]);
        automaticRetries.current.set(entry.id, { timerId, retriesRemaining });
    }

    function acceptReviewResult(id: number) {
        const review = reviewResultsRef.current.find((candidate) => candidate.id === id);
        if (!review || review.accepted || review.result.status !== "recognized") return;
        const retried = acceptLiveLootReviewEntry(review, onAcceptRecognitionRef.current);
        replaceReviewEntry(retried);
        if (retried.accepted) cancelAutomaticRetry(id);
    }

    function clearReviewResults() {
        clearAutomaticRetries();
        reviewResultsRef.current = [];
        setReviewResults([]);
        setOmittedReviewResults(0);
    }

    function releaseStream() {
        stopRecognition();
        if (nativeCapture.current) {
            nativeCapture.current = false;
            void stopNativeDisplayCapture();
        }
        stopDisplayCapture(activeStream.current);
        activeStream.current = null;
        if (video.current) video.current.srcObject = null;
        setStatus("idle");
        setSampledFps(0);
        updateSourceDimensions(null);
        clearRegionPreview("normal");
        clearRegionPreview("rare");
        updateRegion("normal", null);
        updateRegion("rare", null);
        updateCaptureRegion("normal", null);
        updateCaptureRegion("rare", null);
        setRegionConfirmed(false);
        sampledFrames.current = 0;
        measurementStarted.current = performance.now();
        configuredSource.current = "";
    }

    function recordSample() {
        sampledFrames.current += 1;
        const now = performance.now();
        const elapsed = now - measurementStarted.current;
        if (elapsed < 1_000) return;
        setSampledFps((sampledFrames.current * 1_000) / elapsed);
        sampledFrames.current = 0;
        measurementStarted.current = now;
    }

    function stopCapture() {
        requestId.current += 1;
        releaseStream();
    }

    async function startCapture() {
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
                nativeCapture.current = true;
                receivedNativeFrame.current = false;
                await startNativeDisplayCapture(
                    null,
                    (frame) => {
                        if (!mounted.current || !sessionRunning.current || currentRequest !== requestId.current) return;
                        receivedNativeFrame.current = true;
                        if (frame.kind === "preview") {
                            const current = sourceDimensionsRef.current;
                            if (current?.width !== frame.sourceWidth || current.height !== frame.sourceHeight) {
                                updateSourceDimensions({ width: frame.sourceWidth, height: frame.sourceHeight });
                            }
                            setStatus("capturing");
                            recordSample();
                            drawFrame(canvas.current, frame);
                        } else if (frame.kind === "region") {
                            if (!frameMatchesRegion(frame, normalCaptureRegionRef.current, sourceDimensionsRef.current))
                                return;
                            setNormalRegionFrameSize({ width: frame.width, height: frame.height });
                            drawFrame(normalRegionCanvas.current, frame);
                            pushRecognitionFrame({ width: frame.width, height: frame.height, pixels: frame.pixels });
                        } else {
                            if (!frameMatchesRegion(frame, rareCaptureRegionRef.current, sourceDimensionsRef.current))
                                return;
                            setRareRegionFrameSize({ width: frame.width, height: frame.height });
                            drawFrame(rareRegionCanvas.current, frame);
                        }
                    },
                    (message) => {
                        if (!mounted.current || currentRequest !== requestId.current) return;
                        requestId.current += 1;
                        releaseStream();
                        setError(message);
                    },
                );
                if (!mounted.current || !sessionRunning.current || currentRequest !== requestId.current) return;
                if (!receivedNativeFrame.current) setStatus("connecting");
                return;
            }

            stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CAPTURE_OPTIONS);
            if (!mounted.current || !sessionRunning.current || currentRequest !== requestId.current) {
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
                nativeCapture.current = false;
                void stopNativeDisplayCapture();
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
        const next = positionLootRegion(
            (event.clientX - bounds.left) / bounds.width,
            (event.clientY - bounds.top) / bounds.height,
            sourceDimensions.width,
            sourceDimensions.height,
            uiScaleRef.current,
            kind,
        );
        stopRecognition();
        updateRegion(kind, next);
        setRegionConfirmed(false);
        clearRegionPreview(kind);
    }

    function changeUiScale(next: LootUiScale) {
        if (savingRegion) return;
        stopRecognition();
        updateUiScale(next);
        setRegionConfirmed(false);
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
        updateCaptureRegion("normal", nextNormal);
        updateCaptureRegion("rare", nextRare);
        clearRegionPreview("normal");
        clearRegionPreview("rare");
    }

    function changeSelectedRegion(next: NormalizedRegion) {
        if (savingRegion) return;
        const kind = activeRegionKindRef.current;
        stopRecognition();
        updateRegion(kind, next);
        updateCaptureRegion(kind, next);
        setRegionConfirmed(false);
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
        const settings = {
            region: normalRegion,
            rareRegion,
            sourceWidth: sourceDimensions.width,
            sourceHeight: sourceDimensions.height,
            uiScalePercent,
        };
        updateCaptureRegion("normal", normalRegion);
        updateCaptureRegion("rare", rareRegion);
        setSavingRegion(true);
        setError("");
        try {
            if (supportsTauriApi()) await saveLootCaptureSettings(settings);
            setSavedSettings(settings);
            const currentSource = sourceDimensionsRef.current;
            if (
                currentSource?.width === settings.sourceWidth &&
                currentSource.height === settings.sourceHeight &&
                uiScaleRef.current === settings.uiScalePercent &&
                regionsEqual(normalRegionRef.current, settings.region) &&
                regionsEqual(rareRegionRef.current, settings.rareRegion)
            ) {
                setRegionConfirmed(true);
            }
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
            setSavingRegion(false);
        }
    }

    const calibratedProfile = sourceDimensions
        ? findLiveLootProfile(sourceDimensions.width, sourceDimensions.height, uiScalePercent)
        : null;

    useEffect(() => {
        nextReviewResultId.current = 0;
        clearReviewResults();
    }, [sessionId]);

    useEffect(() => {
        stopRecognition(false);
        setRecognitionError("");
        if (sessionStatus !== "running" || status !== "capturing" || !regionConfirmed || !calibratedProfile) {
            setRecognitionStatus(regionConfirmed && sourceDimensions ? "unavailable" : "idle");
            return;
        }

        const generation = recognitionGeneration.current;
        const recognitionSessionRunGeneration = sessionRunGeneration.current;
        setRecognitionStatus("starting");
        const previousStartup = recognitionStartup.current;
        // Tesseract setup cannot be aborted, so stale starts settle and terminate before a replacement begins.
        const startup = (async () => {
            if (previousStartup) await previousStartup.catch(() => undefined);
            if (
                !mounted.current ||
                !sessionRunning.current ||
                recognitionSessionRunGeneration !== sessionRunGeneration.current ||
                generation !== recognitionGeneration.current
            )
                return;
            let createdOcr: LiveLootTesseractOcr | null = null;
            try {
                const ocr = await createLiveLootTesseractOcr();
                createdOcr = ocr;
                if (
                    !mounted.current ||
                    !sessionRunning.current ||
                    recognitionSessionRunGeneration !== sessionRunGeneration.current ||
                    generation !== recognitionGeneration.current
                ) {
                    await ocr.terminate();
                    return;
                }
                const coordinator = new LiveLootCoordinator({
                    profile: calibratedProfile.profile,
                    dictionary: itemDictionaryRef.current,
                    readText: ocr,
                    onResult: (result) => {
                        if (
                            !mounted.current ||
                            !sessionRunning.current ||
                            activeSessionId.current !== sessionId ||
                            recognitionSessionRunGeneration !== sessionRunGeneration.current ||
                            generation !== recognitionGeneration.current
                        )
                            return;
                        const id = nextReviewResultId.current;
                        nextReviewResultId.current += 1;
                        const entry = acceptLiveLootReviewEntry(
                            {
                                id,
                                result,
                                accepted: false,
                                error: "",
                            },
                            onAcceptRecognitionRef.current,
                        );
                        const appended = appendLiveLootReviewResult(reviewResultsRef.current, entry);
                        reviewResultsRef.current = appended.results;
                        setReviewResults(appended.results);
                        scheduleAutomaticRetry(entry, AUTOMATIC_INSERTION_RETRY_DELAYS.length);
                        if (appended.omittedCount > 0) {
                            setOmittedReviewResults((current) => current + appended.omittedCount);
                        }
                    },
                });
                recognition.current = { coordinator, ocr };
                setRecognitionStatus("active");
            } catch (setupError) {
                if (createdOcr) await createdOcr.terminate().catch(() => undefined);
                if (
                    !mounted.current ||
                    !sessionRunning.current ||
                    recognitionSessionRunGeneration !== sessionRunGeneration.current ||
                    generation !== recognitionGeneration.current
                )
                    return;
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
    }, [calibratedProfile, regionConfirmed, sessionId, sessionStatus, sourceDimensions, status]);

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
        clearRegionPreview("normal");
        clearRegionPreview("rare");
        if (!isSupportedLootSource(sourceDimensions.width, sourceDimensions.height)) {
            updateRegion("normal", null);
            updateRegion("rare", null);
            updateCaptureRegion("normal", null);
            updateCaptureRegion("rare", null);
            setRegionConfirmed(false);
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
            confirmed = normalValid && rareValid;
        }
        updateUiScale(selectedScale);
        updateRegion("normal", selectedNormal);
        updateRegion("rare", selectedRare);
        updateCaptureRegion("normal", selectedNormal);
        updateCaptureRegion("rare", selectedRare);
        setRegionConfirmed(confirmed);
    }, [savedSettings, settingsLoaded, sourceDimensions]);

    useEffect(() => {
        if (status !== "capturing" || !nativeCapture.current) return;
        const currentRequest = requestId.current;
        let selection: LootCaptureSettings | null = null;
        if (normalCaptureRegion && rareCaptureRegion && sourceDimensions) {
            const normalPixels = normalizedRegionToPixels(
                normalCaptureRegion,
                sourceDimensions.width,
                sourceDimensions.height,
            );
            const rarePixels = normalizedRegionToPixels(
                rareCaptureRegion,
                sourceDimensions.width,
                sourceDimensions.height,
            );
            const expectedNormal = lootRegionSize(uiScalePercent, "normal");
            const expectedRare = lootRegionSize(uiScalePercent, "rare");
            if (
                normalPixels.width === expectedNormal.width &&
                normalPixels.height === expectedNormal.height &&
                rarePixels.width === expectedRare.width &&
                rarePixels.height === expectedRare.height
            ) {
                selection = {
                    region: normalCaptureRegion,
                    rareRegion: rareCaptureRegion,
                    sourceWidth: sourceDimensions.width,
                    sourceHeight: sourceDimensions.height,
                    uiScalePercent,
                };
            }
        }
        const update = nativeSelectionUpdate.current
            .catch(() => undefined)
            .then(async () => {
                if (!mounted.current || currentRequest !== requestId.current || !nativeCapture.current) return;
                await setNativeDisplayCaptureRegion(selection);
            });
        nativeSelectionUpdate.current = update;
        void update.catch((regionError) => {
            if (!mounted.current || currentRequest !== requestId.current) return;
            setError(regionError instanceof Error ? regionError.message : String(regionError));
        });
    }, [normalCaptureRegion, rareCaptureRegion, sourceDimensions, status, uiScalePercent]);

    useEffect(() => {
        if (sessionStatus !== "running") {
            clearAutomaticRetries();
            if (status !== "idle") stopCapture();
        }
    }, [sessionStatus, status]);

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
            if (output.width !== width || output.height !== height) {
                output.width = width;
                output.height = height;
            }
            const currentSource = sourceDimensionsRef.current;
            const sourceChanged =
                currentSource?.width !== preview.videoWidth || currentSource.height !== preview.videoHeight;
            if (sourceChanged) {
                updateSourceDimensions({ width: preview.videoWidth, height: preview.videoHeight });
                clearRegionPreview("normal");
                clearRegionPreview("rare");
            }
            output.getContext("2d")?.drawImage(preview, 0, 0, width, height);

            if (!sourceChanged && isSupportedLootSource(preview.videoWidth, preview.videoHeight)) {
                const drawBrowserRegion = (kind: LootRegionKind) => {
                    const selected = kind === "normal" ? normalRegionRef.current : rareRegionRef.current;
                    const crop = kind === "normal" ? normalRegionCanvas.current : rareRegionCanvas.current;
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
                    if (kind === "normal" && cropContext && recognition.current) {
                        try {
                            const frame = cropContext.getImageData(0, 0, pixels.width, pixels.height);
                            pushRecognitionFrame({ width: pixels.width, height: pixels.height, pixels: frame.data });
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
            stopRecognition(false);
            stopDisplayCapture(activeStream.current);
            if (nativeCapture.current) void stopNativeDisplayCapture();
        };
    }, []);

    const running = sessionStatus === "running";
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
    const expectedRegionSize = lootRegionSize(uiScalePercent, activeRegionKind);
    const normalGuideFrameSize = lootRegionSize(uiScalePercent, "normal");
    const rareGuideFrameSize = lootRegionSize(uiScalePercent, "rare");
    const normalAlignmentGuide = lootAlignmentGuide(uiScalePercent, "normal");
    const rareAlignmentGuide = lootAlignmentGuide(uiScalePercent, "rare");
    const recognitionLabel = !regionConfirmed
        ? "Confirm both areas"
        : recognitionStatus === "starting"
          ? "Starting local OCR..."
          : recognitionStatus === "active"
            ? "Local OCR active"
            : recognitionStatus === "unavailable"
              ? "No calibrated profile"
              : recognitionStatus === "error"
                ? "Recognition stopped"
                : "Waiting";

    return (
        <section className={styles.CapturePanel} aria-labelledby="live-capture-heading">
            <video ref={video} className={styles.SourceVideo} muted playsInline />
            <div className={styles.Intro}>
                <div>
                    <p className="eyebrow">Automatic recognition prototype</p>
                    <h2 id="live-capture-heading">Live loot capture</h2>
                    <span>Select the monitor showing BDO through the operating-system sharing dialog.</span>
                </div>
                <div className={styles.Actions}>
                    {status !== "idle" ? (
                        <button className="button" type="button" onClick={stopCapture}>
                            {status === "capturing" ? "Stop capture" : "Cancel request"}
                        </button>
                    ) : (
                        <button
                            className="button primary-button"
                            type="button"
                            disabled={!running}
                            onClick={startCapture}
                        >
                            Choose capture source
                        </button>
                    )}
                </div>
            </div>

            {!running && <p className={styles.Note}>Start the grind session before starting screen capture.</p>}
            {status === "requesting" && (
                <p className={styles.Note} role="status">
                    Waiting for the operating-system monitor picker...
                </p>
            )}
            {status === "connecting" && (
                <p className={styles.Note} role="status">
                    Monitor selected. Waiting for the first video frame...
                </p>
            )}
            {error && (
                <p className={styles.Error} role="alert">
                    {error}
                </p>
            )}
            {recognitionError && (
                <p className={styles.Error} role="alert">
                    Local recognition stopped: {recognitionError}
                </p>
            )}
            {status === "capturing" && (
                <div className={styles.CaptureWorkspace}>
                    <div>
                        <div className={styles.Preview}>
                            <div
                                className={styles.PreviewStage}
                                onPointerDown={(event) => {
                                    if (savingRegion) return;
                                    draggingRegion.current = true;
                                    updateCaptureRegion(activeRegionKindRef.current, null);
                                    event.currentTarget.setPointerCapture(event.pointerId);
                                    moveRegion(event);
                                }}
                                onPointerMove={(event) => {
                                    if (draggingRegion.current) moveRegion(event);
                                }}
                                onPointerUp={(event) => {
                                    draggingRegion.current = false;
                                    const kind = activeRegionKindRef.current;
                                    updateCaptureRegion(
                                        kind,
                                        kind === "normal" ? normalRegionRef.current : rareRegionRef.current,
                                    );
                                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                        event.currentTarget.releasePointerCapture(event.pointerId);
                                    }
                                }}
                                onPointerCancel={() => {
                                    draggingRegion.current = false;
                                    const kind = activeRegionKindRef.current;
                                    updateCaptureRegion(
                                        kind,
                                        kind === "normal" ? normalRegionRef.current : rareRegionRef.current,
                                    );
                                }}
                            >
                                <canvas ref={canvas} aria-label="Sampled capture preview" />
                                {sourceSupported && normalRegion && (
                                    <div
                                        className={`${styles.RegionOverlay} ${styles.NormalRegionOverlay} ${
                                            activeRegionKind === "normal" ? styles.ActiveRegionOverlay : ""
                                        }`}
                                        style={{
                                            left: `${normalRegion.x * 100}%`,
                                            top: `${normalRegion.y * 100}%`,
                                            width: `${normalRegion.width * 100}%`,
                                            height: `${normalRegion.height * 100}%`,
                                        }}
                                    >
                                        <span className={styles.OverlayLabel}>Capture envelope</span>
                                        <AlignmentGuide frameSize={normalGuideFrameSize} guide={normalAlignmentGuide} />
                                    </div>
                                )}
                                {sourceSupported && rareRegion && (
                                    <div
                                        className={`${styles.RegionOverlay} ${styles.RareRegionOverlay} ${
                                            activeRegionKind === "rare" ? styles.ActiveRegionOverlay : ""
                                        }`}
                                        style={{
                                            left: `${rareRegion.x * 100}%`,
                                            top: `${rareRegion.y * 100}%`,
                                            width: `${rareRegion.width * 100}%`,
                                            height: `${rareRegion.height * 100}%`,
                                        }}
                                    >
                                        <span className={styles.OverlayLabel}>Rare preview area</span>
                                        <AlignmentGuide frameSize={rareGuideFrameSize} guide={rareAlignmentGuide} />
                                    </div>
                                )}
                            </div>
                        </div>
                        {sourceDimensions && !sourceSupported ? (
                            <p className={styles.CalibrationError} role="status">
                                Supported sources are 3440 x 1440, 2560 x 1440, and 1920 x 1080.
                            </p>
                        ) : (
                            <div className={styles.CalibrationPanel}>
                                <fieldset className={styles.AreaSelector}>
                                    <legend>Active area</legend>
                                    <div className={styles.AreaSelectorButtons}>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            aria-pressed={activeRegionKind === "normal"}
                                            onClick={() => selectRegionKind("normal")}
                                        >
                                            Loot stack
                                        </button>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            aria-pressed={activeRegionKind === "rare"}
                                            onClick={() => selectRegionKind("rare")}
                                        >
                                            Rare loot
                                        </button>
                                    </div>
                                </fieldset>
                                <p className={styles.CalibrationInstruction}>
                                    Drag the selected {expectedRegionSize.width} x {expectedRegionSize.height} area.{" "}
                                    {activeRegionKind === "normal"
                                        ? "Align notification text inside the inner guide. "
                                        : "Align rare-banner text inside the inner guide; rare detection is still preview-only. "}
                                    Confirm after placing both.
                                </p>
                                <div className={styles.PrecisionControls}>
                                    <span>Fine position (1 source pixel)</span>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={savingRegion}
                                        onClick={resetSelectedRegion}
                                    >
                                        Reset selected area
                                    </button>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={savingRegion}
                                        onClick={() => nudgeSelectedRegion(0, -1)}
                                    >
                                        Up
                                    </button>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={savingRegion}
                                        onClick={() => nudgeSelectedRegion(0, 1)}
                                    >
                                        Down
                                    </button>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={savingRegion}
                                        onClick={() => nudgeSelectedRegion(-1, 0)}
                                    >
                                        Left
                                    </button>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={savingRegion}
                                        onClick={() => nudgeSelectedRegion(1, 0)}
                                    >
                                        Right
                                    </button>
                                </div>
                                <div className={styles.CalibrationBar}>
                                    <label className={styles.ScaleControl}>
                                        BDO UI scale
                                        <select
                                            value={uiScalePercent}
                                            disabled={savingRegion}
                                            onChange={(event) =>
                                                changeUiScale(Number(event.currentTarget.value) as LootUiScale)
                                            }
                                        >
                                            <option value={80}>80%</option>
                                            <option value={100}>100%</option>
                                        </select>
                                    </label>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={!normalRegion || !rareRegion || regionConfirmed || savingRegion}
                                        onClick={confirmRegion}
                                    >
                                        {savingRegion
                                            ? "Saving..."
                                            : regionConfirmed
                                              ? "Both areas confirmed"
                                              : "Confirm both areas"}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                    <aside className={styles.CaptureSidebar}>
                        <dl className={styles.Diagnostics} aria-live="polite">
                            <div>
                                <dt>Status</dt>
                                <dd className={styles.Active}>Capture active</dd>
                            </div>
                            <div>
                                <dt>Source</dt>
                                <dd>{sourceSize}</dd>
                            </div>
                            <div>
                                <dt>Sampled rate</dt>
                                <dd className={sampledFps >= 5 ? styles.Active : styles.Warning}>
                                    {sampledFps > 0 ? `${sampledFps.toFixed(1)} FPS` : "Measuring..."}
                                </dd>
                            </div>
                            <div>
                                <dt>Loot stack area</dt>
                                <dd>
                                    {normalRegionPixels
                                        ? `${normalRegionPixels.x}, ${normalRegionPixels.y} at ${normalRegionPixels.width} x ${normalRegionPixels.height}`
                                        : "Unavailable"}
                                </dd>
                            </div>
                            <div>
                                <dt>Recognition crop</dt>
                                <dd className={normalRegionFrameSize ? styles.Active : styles.Warning}>
                                    {normalRegionFrameSize
                                        ? `${normalRegionFrameSize.width} x ${normalRegionFrameSize.height}`
                                        : normalRegionPixels
                                          ? "Waiting for pixels..."
                                          : "Unavailable"}
                                </dd>
                            </div>
                            <div>
                                <dt>Rare loot area</dt>
                                <dd>
                                    {rareRegionPixels
                                        ? `${rareRegionPixels.x}, ${rareRegionPixels.y} at ${rareRegionPixels.width} x ${rareRegionPixels.height}`
                                        : "Unavailable"}
                                </dd>
                            </div>
                            <div>
                                <dt>Rare preview crop</dt>
                                <dd className={rareRegionFrameSize ? styles.Active : styles.Warning}>
                                    {rareRegionFrameSize
                                        ? `${rareRegionFrameSize.width} x ${rareRegionFrameSize.height}`
                                        : rareRegionPixels
                                          ? "Waiting for pixels..."
                                          : "Unavailable"}
                                </dd>
                            </div>
                            <div>
                                <dt>Recognition</dt>
                                <dd className={recognitionStatus === "active" ? styles.Active : styles.Warning}>
                                    {recognitionLabel}
                                </dd>
                            </div>
                            <div>
                                <dt>Item profile</dt>
                                <dd>
                                    {grindSpotName} ({itemDictionary.length})
                                </dd>
                            </div>
                        </dl>
                        <div className={styles.RegionPreview}>
                            <span>Normal recognition preview</span>
                            <div className={styles.RegionPreviewStage}>
                                <canvas ref={normalRegionCanvas} aria-label="Loot stack recognition crop" />
                                {normalRegionFrameSize && (
                                    <AlignmentGuide frameSize={normalGuideFrameSize} guide={normalAlignmentGuide} />
                                )}
                            </div>
                        </div>
                        <div className={`${styles.RegionPreview} ${styles.RareRegionPreview}`}>
                            <span>Rare loot preview</span>
                            <div className={styles.RegionPreviewStage}>
                                <canvas ref={rareRegionCanvas} aria-label="Rare loot preview crop" />
                                {rareRegionFrameSize && (
                                    <AlignmentGuide frameSize={rareGuideFrameSize} guide={rareAlignmentGuide} />
                                )}
                            </div>
                            <p>Preview only - recognition benchmark pending</p>
                        </div>
                    </aside>
                </div>
            )}
            <div className={styles.RecognitionAnnouncements} aria-live="polite" aria-atomic="true">
                {reviewResults[0] ? resultDescription(reviewResults[0].result) : ""}
            </div>
            {reviewResults.length > 0 && (
                <div className={styles.ReviewFeed}>
                    <div className={styles.ReviewHeader}>
                        <div>
                            <p className="eyebrow">Local OCR review</p>
                            <h3>Recent notifications</h3>
                        </div>
                        <button className="button subtle" type="button" onClick={clearReviewResults}>
                            Clear
                        </button>
                    </div>
                    {omittedReviewResults > 0 && (
                        <p className={styles.FeedWarning} role="status">
                            {`${omittedReviewResults} older ${omittedReviewResults === 1 ? "result was" : "results were"} omitted from this bounded review feed.`}
                        </p>
                    )}
                    <ul>
                        {reviewResults.map((review) => (
                            <li key={review.id}>
                                <div>
                                    <span className={`${styles.ResultStatus} ${styles[review.result.status]}`}>
                                        {review.result.status}
                                    </span>
                                    <strong>{resultDescription(review.result)}</strong>
                                    {review.result.eventId && <small>{review.result.eventId}</small>}
                                    {review.error && <small className={styles.ResultError}>{review.error}</small>}
                                </div>
                                {review.result.status === "recognized" && review.accepted && (
                                    <span className={styles.AutoAdded}>Added automatically</span>
                                )}
                                {review.result.status === "recognized" && !review.accepted && (
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={sessionStatus === "finished"}
                                        onClick={() => acceptReviewResult(review.id)}
                                    >
                                        Retry add
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                    <p>
                        Recognized notifications are added automatically. Insertion errors are retried three times and
                        can also be retried manually; withheld or failed notifications can be entered through the manual
                        loot form.
                    </p>
                </div>
            )}
            <p className={styles.PrivacyNote}>
                Capture pixels stay in memory and are never saved or uploaded. After both areas are confirmed, only the
                normal loot-stack crop is processed by the bundled local OCR worker; the rare-loot crop remains a
                preview. Only confirmed coordinates, source dimensions, and BDO UI scale are stored.
            </p>
        </section>
    );
}
