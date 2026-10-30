import { type RefObject, useEffect, useRef, useState } from "react";
import {
    type DebugRoiSampleCollectionStatus,
    debugRoiSampleCollectionStatus,
    logRoiOcrIssue,
    startDebugRoiSampleCollection,
    stopDebugRoiSampleCollection,
} from "../../api/tauri";
import { formatDuration } from "../../format";
import type { LootFont } from "../../recognition/lootFont";
import type { RoiOcrIssue } from "../../recognition/roiOcrDiagnostics";

function formatSampleCollectionBytes(bytes: number) {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

const finishReasons: Record<string, string> = {
    captureEnded: "Capture stopped.",
    captureReplaced: "The capture source was replaced.",
    sourceMismatch: "The capture source changed size.",
    selectionChanged: "The loot areas changed.",
    writeFailed: "Samples could not be written.",
};

export type SampleCollectionSummary = {
    tone: "recording" | "waiting" | "problem";
    label: string;
    detail: string;
};

/** The one-line recording status shown in the capture card while ROI sample recording is enabled. */
export function describeSampleCollection({
    collection,
    busy,
    ready,
    timerRunning,
    changeFailed,
    now,
}: {
    collection: DebugRoiSampleCollectionStatus | null;
    busy: boolean;
    ready: boolean;
    timerRunning: boolean;
    /** The last start or stop request failed; its message is shown separately. */
    changeFailed: boolean;
    now: number;
}): SampleCollectionSummary {
    const size = collection ? formatSampleCollectionBytes(collection.bytesWritten) : "";
    const dropped = collection?.droppedBatchCount ? ` · ${collection.droppedBatchCount} dropped` : "";
    if (collection?.phase === "failed")
        return {
            tone: "problem",
            label: "ROI samples failed",
            detail: collection.error ?? "Samples could not be written.",
        };
    if (collection?.phase === "running")
        return {
            tone: "recording",
            label: "Recording ROI samples",
            detail: `${formatDuration(now - (collection.startedAtUnixMs ?? now))} · ${size}${dropped}`,
        };
    if (collection?.phase === "finalizing")
        return { tone: "waiting", label: "Finishing ROI samples…", detail: `${size}${dropped}` };
    if (busy) return { tone: "waiting", label: "Starting ROI samples…", detail: "" };
    if (!ready) return { tone: "waiting", label: "ROI samples waiting", detail: "Confirm both loot areas to start." };
    const lastRun = collection?.phase === "finished" ? ` Last run: ${size}${dropped}.` : "";
    if (!timerRunning)
        return { tone: "waiting", label: "ROI samples paused", detail: `Starts with the session timer.${lastRun}` };
    if (collection?.phase === "finished" && collection.finishReason !== "explicitlyStopped")
        return {
            tone: "problem",
            label: "ROI samples stopped",
            detail: `${finishReasons[collection.finishReason ?? ""] ?? "Recording ended."} Pause and resume the timer to record again.`,
        };
    // A failed start is not retried within the same stretch of running timer.
    if (changeFailed)
        return {
            tone: "problem",
            label: "ROI samples could not start",
            detail: "Pause and resume the timer to try again.",
        };
    return { tone: "waiting", label: "Starting ROI samples…", detail: "" };
}

/**
 * What a wanted or unwanted collection needs next. A run starts once per stretch of `wanted`, so one that ends on its own
 * or fails to start is not retried until recording stops being wanted and becomes wanted again. A run still going from
 * an earlier stretch, such as when the timer was paused and resumed while it was starting, is stopped so the next one
 * covers only the current stretch.
 */
export function sampleCollectionChange(
    wanted: boolean,
    phase: DebugRoiSampleCollectionStatus["phase"] | undefined,
    startedWhileWanted: boolean,
) {
    if (phase === "running") return wanted && startedWhileWanted ? null : "stop";
    if (!wanted || phase === "finalizing" || startedWhileWanted) return null;
    return "start";
}

/**
 * Development-only ROI sample recording from native capture, plus the OCR issue log it is reviewed with.
 * A run records while the caller wants it, which is while the setting is on and the session timer runs.
 */
export function useDebugSampleCollection({
    candidate,
    font,
    nativeCaptureToken,
    waitForNativeSelection,
}: {
    candidate: boolean;
    font: LootFont;
    nativeCaptureToken: RefObject<number | null>;
    waitForNativeSelection: () => Promise<void>;
}) {
    const mounted = useRef(true);
    const sampleCollectionRevision = useRef(0);
    const sampleCollectionRef = useRef<DebugRoiSampleCollectionStatus | null>(null);
    const diagnosticWrites = useRef(0);
    const [sampleCollection, setSampleCollectionState] = useState<DebugRoiSampleCollectionStatus | null>(null);
    const [sampleDiagnosticError, setSampleDiagnosticError] = useState("");
    const [sampleCollectionBusy, setSampleCollectionBusy] = useState(false);
    const [sampleCollectionError, setSampleCollectionError] = useState("");
    const [sampleCollectionNow, setSampleCollectionNow] = useState(Date.now());
    const [debugSampleCollectionAvailable, setDebugSampleCollectionAvailable] = useState(false);
    // Whether a run was started during the current stretch of `wanted`.
    const startedWhileWanted = useRef(false);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        if (!candidate) return;
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
    }, [candidate]);

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

    function setSampleCollection(next: DebugRoiSampleCollectionStatus) {
        sampleCollectionRef.current = next;
        setSampleCollectionState(next);
    }

    function emitOcrIssue(issue: RoiOcrIssue) {
        if (diagnosticWrites.current >= 32) {
            setSampleDiagnosticError("OCR diagnostic queue is full; some OCR logs were dropped.");
            return;
        }
        diagnosticWrites.current += 1;
        void logRoiOcrIssue({ ...issue, font })
            .catch((error) => {
                if (mounted.current) setSampleDiagnosticError(`Could not save OCR diagnostics: ${String(error)}`);
            })
            .finally(() => {
                diagnosticWrites.current -= 1;
            });
    }

    /** Where to record a captured frame batch, or undefined when no collection is running. */
    function sampleReference(batchId: number) {
        const run = sampleCollectionRef.current;
        const captureToken = nativeCaptureToken.current;
        if (run?.phase !== "running" || !run.path || captureToken === null) return undefined;
        return { captureToken, collectionPath: run.path, batchId };
    }

    /** Stops tagging frames for a collection whose native capture has ended. */
    function forgetSampleCollection() {
        sampleCollectionRef.current = null;
    }

    /** Starts or stops a run so that one is recording exactly while `wanted` holds. */
    function syncSampleCollection(wanted: boolean) {
        if (!wanted) startedWhileWanted.current = false;
        if (sampleCollectionBusy) return;
        const change = sampleCollectionChange(wanted, sampleCollection?.phase, startedWhileWanted.current);
        if (change === "start") startedWhileWanted.current = true;
        if (change) void changeSampleCollection(change);
    }

    async function changeSampleCollection(change: "start" | "stop") {
        const captureToken = nativeCaptureToken.current;
        if (captureToken === null) return;
        const revision = ++sampleCollectionRevision.current;
        setSampleCollectionBusy(true);
        setSampleCollectionError("");
        try {
            let next: DebugRoiSampleCollectionStatus;
            if (change === "stop") {
                sampleCollectionRef.current = null;
                next = await stopDebugRoiSampleCollection(captureToken);
            } else {
                await waitForNativeSelection();
                next = await startDebugRoiSampleCollection(captureToken);
                setSampleDiagnosticError("");
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
            // Busy prevents overlapping changes, so only a status refresh can bump the revision; never leave busy stuck.
            if (mounted.current) setSampleCollectionBusy(false);
        }
    }

    return {
        sampleCollection,
        sampleCollectionBusy,
        sampleCollectionNow,
        sampleCollectionChangeFailed: sampleCollectionError !== "",
        sampleCollectionError: [sampleCollectionError, sampleDiagnosticError].filter(Boolean).join(" "),
        debugSampleCollectionAvailable,
        syncSampleCollection,
        emitOcrIssue,
        sampleReference,
        forgetSampleCollection,
    };
}
