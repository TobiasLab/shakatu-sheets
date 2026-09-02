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
    type LootUiScale,
    lootRegionSize,
    type NormalizedRegion,
    normalizedRegionToPixels,
    positionLootRegion,
    stopDisplayCapture,
} from "../../recognition/displayCapture";
import { LiveLootCoordinator, type LiveLootRecognitionResult, type LootRoiFrame } from "../../recognition/liveLoot";
import { createLiveLootTesseractOcr, type LiveLootTesseractOcr } from "../../recognition/liveLootOcr";
import { findLiveLootProfile } from "../../recognition/liveLootProfiles";
import { appendLiveLootReviewResult, type LiveLootReviewEntry } from "../../recognition/liveLootReview";
import styles from "./LiveLootCapture.module.css";

type CaptureStatus = "idle" | "requesting" | "connecting" | "capturing";
type RecognitionStatus = "idle" | "starting" | "active" | "unavailable" | "error";
type SourceDimensions = { width: number; height: number };
type RecognitionPipeline = {
    coordinator: LiveLootCoordinator;
    ocr: LiveLootTesseractOcr;
};
type LiveLootCaptureProps = {
    sessionId: string;
    sessionStatus: SessionStatus;
    grindSpotName: string;
    itemDictionary: readonly string[];
    onAcceptRecognition: (itemName: string, quantity: number) => string | null;
};

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
    const regionCanvas = useRef<HTMLCanvasElement>(null);
    const activeStream = useRef<MediaStream | null>(null);
    const nativeCapture = useRef(false);
    const receivedNativeFrame = useRef(false);
    const sampledFrames = useRef(0);
    const measurementStarted = useRef(performance.now());
    const requestId = useRef(0);
    const mounted = useRef(true);
    const sessionRunning = useRef(sessionStatus === "running");
    const draggingRegion = useRef(false);
    const configuredSource = useRef("");
    const regionRef = useRef<NormalizedRegion | null>(null);
    const sourceDimensionsRef = useRef<SourceDimensions | null>(null);
    const uiScaleRef = useRef<LootUiScale>(80);
    const recognition = useRef<RecognitionPipeline | null>(null);
    const recognitionGeneration = useRef(0);
    const recognitionStartup = useRef<Promise<void> | null>(null);
    const nextReviewResultId = useRef(0);
    const reviewResultsRef = useRef<LiveLootReviewEntry[]>([]);
    const itemDictionaryRef = useRef(itemDictionary);
    const onAcceptRecognitionRef = useRef(onAcceptRecognition);
    const [status, setStatus] = useState<CaptureStatus>("idle");
    const [error, setError] = useState("");
    const [sampledFps, setSampledFps] = useState(0);
    const [sourceDimensions, setSourceDimensions] = useState<SourceDimensions | null>(null);
    const [regionFrameSize, setRegionFrameSize] = useState<SourceDimensions | null>(null);
    const [savedSettings, setSavedSettings] = useState<LootCaptureSettings | null>(null);
    const [settingsLoaded, setSettingsLoaded] = useState(() => !supportsTauriApi());
    const [region, setRegion] = useState<NormalizedRegion | null>(null);
    const [captureRegion, setCaptureRegion] = useState<NormalizedRegion | null>(null);
    const [uiScalePercent, setUiScalePercent] = useState<LootUiScale>(80);
    const [regionConfirmed, setRegionConfirmed] = useState(false);
    const [savingRegion, setSavingRegion] = useState(false);
    const [recognitionStatus, setRecognitionStatus] = useState<RecognitionStatus>("idle");
    const [recognitionError, setRecognitionError] = useState("");
    const [reviewResults, setReviewResults] = useState<LiveLootReviewEntry[]>([]);
    const [omittedReviewResults, setOmittedReviewResults] = useState(0);

    sessionRunning.current = sessionStatus === "running";
    itemDictionaryRef.current = itemDictionary;
    onAcceptRecognitionRef.current = onAcceptRecognition;

    function updateRegion(next: NormalizedRegion | null) {
        regionRef.current = next;
        setRegion(next);
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

    function acceptReviewResult(id: number) {
        const review = reviewResults.find((candidate) => candidate.id === id);
        if (!review || review.accepted || review.result.status !== "recognized") return;
        const acceptanceError = onAcceptRecognitionRef.current(review.result.itemName, review.result.quantity);
        const next = reviewResultsRef.current.map((candidate) =>
            candidate.id === id
                ? { ...candidate, accepted: acceptanceError === null, error: acceptanceError ?? "" }
                : candidate,
        );
        reviewResultsRef.current = next;
        setReviewResults(next);
    }

    function clearReviewResults() {
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
        setRegionFrameSize(null);
        updateRegion(null);
        setCaptureRegion(null);
        clearCanvas(regionCanvas.current);
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
                        } else {
                            const currentSource = sourceDimensionsRef.current;
                            const selected = regionRef.current;
                            if (!currentSource || !selected) return;
                            const pixels = normalizedRegionToPixels(
                                selected,
                                currentSource.width,
                                currentSource.height,
                            );
                            if (
                                frame.sourceWidth !== currentSource.width ||
                                frame.sourceHeight !== currentSource.height ||
                                frame.cropX !== pixels.x ||
                                frame.cropY !== pixels.y ||
                                frame.width !== pixels.width ||
                                frame.height !== pixels.height
                            ) {
                                return;
                            }
                            setRegionFrameSize({ width: frame.width, height: frame.height });
                            drawFrame(regionCanvas.current, frame);
                            pushRecognitionFrame({ width: frame.width, height: frame.height, pixels: frame.pixels });
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
        if (!sourceDimensions || !isSupportedLootSource(sourceDimensions.width, sourceDimensions.height)) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;
        const next = positionLootRegion(
            (event.clientX - bounds.left) / bounds.width,
            (event.clientY - bounds.top) / bounds.height,
            sourceDimensions.width,
            sourceDimensions.height,
            uiScaleRef.current,
        );
        stopRecognition();
        updateRegion(next);
        setRegionConfirmed(false);
        setRegionFrameSize(null);
        clearCanvas(regionCanvas.current);
    }

    function changeUiScale(next: LootUiScale) {
        stopRecognition();
        updateUiScale(next);
        const currentSource = sourceDimensionsRef.current;
        if (!currentSource || !isSupportedLootSource(currentSource.width, currentSource.height)) return;
        const currentRegion = regionRef.current;
        const nextRegion = currentRegion
            ? positionLootRegion(
                  currentRegion.x + currentRegion.width / 2,
                  currentRegion.y + currentRegion.height / 2,
                  currentSource.width,
                  currentSource.height,
                  next,
              )
            : defaultLootRegion(currentSource.width, currentSource.height, next);
        updateRegion(nextRegion);
        setCaptureRegion(nextRegion);
        setRegionConfirmed(false);
        setRegionFrameSize(null);
        clearCanvas(regionCanvas.current);
    }

    async function confirmRegion() {
        if (!sourceDimensions || !region) return;
        const settings = {
            region,
            sourceWidth: sourceDimensions.width,
            sourceHeight: sourceDimensions.height,
            uiScalePercent,
        };
        setCaptureRegion(region);
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
                regionsEqual(regionRef.current, settings.region)
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
        if (status !== "capturing" || !regionConfirmed || !calibratedProfile) {
            setRecognitionStatus(regionConfirmed && sourceDimensions ? "unavailable" : "idle");
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
                const coordinator = new LiveLootCoordinator({
                    profile: calibratedProfile.profile,
                    dictionary: itemDictionaryRef.current,
                    readText: ocr,
                    onResult: (result) => {
                        if (!mounted.current || generation !== recognitionGeneration.current) return;
                        const id = nextReviewResultId.current;
                        nextReviewResultId.current += 1;
                        const appended = appendLiveLootReviewResult(reviewResultsRef.current, {
                            id,
                            result,
                            accepted: false,
                            error: "",
                        });
                        reviewResultsRef.current = appended.results;
                        setReviewResults(appended.results);
                        if (appended.omittedCount > 0) {
                            setOmittedReviewResults((current) => current + appended.omittedCount);
                        }
                    },
                });
                recognition.current = { coordinator, ocr };
                setRecognitionStatus("active");
            } catch (setupError) {
                if (createdOcr) await createdOcr.terminate().catch(() => undefined);
                if (!mounted.current || generation !== recognitionGeneration.current) return;
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
    }, [calibratedProfile, regionConfirmed, sourceDimensions, status]);

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
        setRegionFrameSize(null);
        clearCanvas(regionCanvas.current);
        if (!isSupportedLootSource(sourceDimensions.width, sourceDimensions.height)) {
            updateRegion(null);
            setCaptureRegion(null);
            setRegionConfirmed(false);
            return;
        }

        let selectedScale = uiScaleRef.current;
        let selected = defaultLootRegion(sourceDimensions.width, sourceDimensions.height, selectedScale);
        let confirmed = false;
        if (
            savedSettings?.sourceWidth === sourceDimensions.width &&
            savedSettings.sourceHeight === sourceDimensions.height
        ) {
            selectedScale = savedSettings.uiScalePercent;
            const pixels = normalizedRegionToPixels(
                savedSettings.region,
                sourceDimensions.width,
                sourceDimensions.height,
            );
            const expected = lootRegionSize(selectedScale);
            if (pixels.width === expected.width && pixels.height === expected.height) {
                selected = savedSettings.region;
                confirmed = true;
            }
        }
        updateUiScale(selectedScale);
        updateRegion(selected);
        setCaptureRegion(selected);
        setRegionConfirmed(confirmed);
    }, [savedSettings, settingsLoaded, sourceDimensions]);

    useEffect(() => {
        if (status !== "capturing" || !nativeCapture.current) return;
        const currentRequest = requestId.current;
        let selection: LootCaptureSettings | null = null;
        if (captureRegion && sourceDimensions) {
            const pixels = normalizedRegionToPixels(captureRegion, sourceDimensions.width, sourceDimensions.height);
            const expected = lootRegionSize(uiScalePercent);
            if (pixels.width === expected.width && pixels.height === expected.height) {
                selection = {
                    region: captureRegion,
                    sourceWidth: sourceDimensions.width,
                    sourceHeight: sourceDimensions.height,
                    uiScalePercent,
                };
            }
        }
        void setNativeDisplayCaptureRegion(selection).catch((regionError) => {
            if (!mounted.current || currentRequest !== requestId.current) return;
            setError(regionError instanceof Error ? regionError.message : String(regionError));
        });
    }, [captureRegion, sourceDimensions, status, uiScalePercent]);

    useEffect(() => {
        if (sessionStatus !== "running" && status !== "idle") stopCapture();
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
                setRegionFrameSize(null);
                clearCanvas(regionCanvas.current);
            }
            output.getContext("2d")?.drawImage(preview, 0, 0, width, height);

            const selected = regionRef.current;
            const crop = regionCanvas.current;
            if (!sourceChanged && selected && crop && isSupportedLootSource(preview.videoWidth, preview.videoHeight)) {
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
                if (cropContext && recognition.current) {
                    try {
                        const frame = cropContext.getImageData(0, 0, pixels.width, pixels.height);
                        pushRecognitionFrame({ width: pixels.width, height: pixels.height, pixels: frame.data });
                    } catch (frameError) {
                        stopRecognition(false);
                        setRecognitionStatus("error");
                        setRecognitionError(frameError instanceof Error ? frameError.message : String(frameError));
                    }
                }
                setRegionFrameSize((current) =>
                    current?.width === pixels.width && current.height === pixels.height
                        ? current
                        : { width: pixels.width, height: pixels.height },
                );
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
    const regionPixels =
        region && sourceDimensions
            ? normalizedRegionToPixels(region, sourceDimensions.width, sourceDimensions.height)
            : null;
    const expectedRegionSize = lootRegionSize(uiScalePercent);
    const recognitionLabel = !regionConfirmed
        ? "Confirm area"
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
                                    draggingRegion.current = true;
                                    event.currentTarget.setPointerCapture(event.pointerId);
                                    moveRegion(event);
                                }}
                                onPointerMove={(event) => {
                                    if (draggingRegion.current) moveRegion(event);
                                }}
                                onPointerUp={(event) => {
                                    draggingRegion.current = false;
                                    setCaptureRegion(regionRef.current);
                                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                        event.currentTarget.releasePointerCapture(event.pointerId);
                                    }
                                }}
                                onPointerCancel={() => {
                                    draggingRegion.current = false;
                                    setCaptureRegion(regionRef.current);
                                }}
                            >
                                <canvas ref={canvas} aria-label="Sampled capture preview" />
                                {sourceSupported && region && (
                                    <div
                                        className={styles.RegionOverlay}
                                        style={{
                                            left: `${region.x * 100}%`,
                                            top: `${region.y * 100}%`,
                                            width: `${region.width * 100}%`,
                                            height: `${region.height * 100}%`,
                                        }}
                                    >
                                        <span>Loot area</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        {sourceDimensions && !sourceSupported ? (
                            <p className={styles.CalibrationError} role="status">
                                Supported sources are 3440 x 1440, 2560 x 1440, and 1920 x 1080.
                            </p>
                        ) : (
                            <div className={styles.CalibrationBar}>
                                <span>
                                    Drag the highlighted {expectedRegionSize.width} x {expectedRegionSize.height} area
                                    over the loot notifications, then confirm it.
                                </span>
                                <div className={styles.CalibrationControls}>
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
                                        disabled={!region || regionConfirmed || savingRegion}
                                        onClick={confirmRegion}
                                    >
                                        {savingRegion
                                            ? "Saving..."
                                            : regionConfirmed
                                              ? "Area confirmed"
                                              : "Confirm area"}
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
                                <dt>Recognition crop</dt>
                                <dd className={regionFrameSize ? styles.Active : styles.Warning}>
                                    {regionFrameSize
                                        ? `${regionFrameSize.width} x ${regionFrameSize.height}`
                                        : regionPixels
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
                            <span>In-memory recognition crop</span>
                            <canvas ref={regionCanvas} aria-label="Loot recognition crop" />
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
                                {review.result.status === "recognized" && (
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={review.accepted || sessionStatus === "finished"}
                                        onClick={() => acceptReviewResult(review.id)}
                                    >
                                        {review.accepted ? "Added" : "Add to ledger"}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                    <p>Withheld or failed notifications can be entered through the manual loot form.</p>
                </div>
            )}
            <p className={styles.PrivacyNote}>
                Preview and crop pixels stay in memory, are processed only by the bundled local OCR worker, and are
                never saved or uploaded. Only confirmed coordinates, source dimensions, and BDO UI scale are stored.
            </p>
        </section>
    );
}
