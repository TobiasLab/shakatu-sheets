import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../../domain/session";
import {
    DISPLAY_CAPTURE_OPTIONS,
    displayCaptureErrorMessage,
    stopDisplayCapture,
    waitForDisplayCapture,
} from "../../recognition/displayCapture";
import styles from "./LiveLootCapture.module.css";

type CaptureStatus = "idle" | "requesting" | "connecting" | "capturing";

export function LiveLootCapture({ sessionStatus }: { sessionStatus: SessionStatus }) {
    const video = useRef<HTMLVideoElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const activeStream = useRef<MediaStream | null>(null);
    const requestId = useRef(0);
    const mounted = useRef(true);
    const sessionRunning = useRef(sessionStatus === "running");
    const [status, setStatus] = useState<CaptureStatus>("idle");
    const [error, setError] = useState("");
    const [sampledFps, setSampledFps] = useState(0);
    const [sourceSize, setSourceSize] = useState("");

    sessionRunning.current = sessionStatus === "running";

    function releaseStream() {
        stopDisplayCapture(activeStream.current);
        activeStream.current = null;
        if (video.current) video.current.srcObject = null;
        setStatus("idle");
        setSampledFps(0);
        setSourceSize("");
    }

    function stopCapture() {
        requestId.current += 1;
        releaseStream();
    }

    async function startCapture() {
        stopCapture();
        setError("");
        if (!navigator.mediaDevices?.getDisplayMedia) {
            setError("This WebView does not support operating-system screen capture.");
            return;
        }

        const currentRequest = ++requestId.current;
        setStatus("requesting");
        let stream: MediaStream | null = null;
        let captureRequest: Promise<MediaStream> | null = null;
        try {
            captureRequest = navigator.mediaDevices.getDisplayMedia(DISPLAY_CAPTURE_OPTIONS);
            stream = await waitForDisplayCapture(captureRequest);
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
            stopDisplayCapture(stream);
            if (!stream && captureRequest) captureRequest.then(stopDisplayCapture, () => {});
            if (!mounted.current || currentRequest !== requestId.current) return;
            activeStream.current = null;
            setStatus("idle");
            setError(displayCaptureErrorMessage(captureError));
        }
    }

    useEffect(() => {
        if (sessionStatus !== "running" && status !== "idle") stopCapture();
    }, [sessionStatus, status]);

    useEffect(() => {
        if (status !== "capturing") return;
        let sampledFrames = 0;
        let lastVideoTime = -1;
        let measurementStarted = performance.now();
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
                setSourceSize(`${preview.videoWidth} x ${preview.videoHeight}`);
            }
            output.getContext("2d")?.drawImage(preview, 0, 0, width, height);
            sampledFrames += 1;

            const now = performance.now();
            const elapsed = now - measurementStarted;
            if (elapsed < 1_000) return;
            setSampledFps((sampledFrames * 1_000) / elapsed);
            sampledFrames = 0;
            measurementStarted = now;
        }, 125);
        return () => window.clearInterval(timer);
    }, [status]);

    useEffect(
        () => () => {
            mounted.current = false;
            requestId.current += 1;
            stopDisplayCapture(activeStream.current);
        },
        [],
    );

    const running = sessionStatus === "running";
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
            {status === "capturing" && (
                <div className={styles.CaptureWorkspace}>
                    <div className={styles.Preview}>
                        <canvas ref={canvas} aria-label="Sampled capture preview" />
                    </div>
                    <dl className={styles.Diagnostics} aria-live="polite">
                        <div>
                            <dt>Status</dt>
                            <dd className={styles.Active}>Capture active</dd>
                        </div>
                        <div>
                            <dt>Source</dt>
                            <dd>{sourceSize || "Reading dimensions..."}</dd>
                        </div>
                        <div>
                            <dt>Sampled rate</dt>
                            <dd className={sampledFps >= 5 ? styles.Active : styles.Warning}>
                                {sampledFps > 0 ? `${sampledFps.toFixed(1)} FPS` : "Measuring..."}
                            </dd>
                        </div>
                    </dl>
                </div>
            )}
            <p className={styles.PrivacyNote}>Frames stay in memory and are not saved, uploaded, or sent to OCR yet.</p>
        </section>
    );
}
