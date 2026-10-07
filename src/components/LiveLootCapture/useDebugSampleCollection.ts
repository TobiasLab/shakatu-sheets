import { type RefObject, useEffect, useRef, useState } from "react";
import {
    type DebugRoiSampleCollectionStatus,
    debugRoiSampleCollectionStatus,
    logRoiOcrIssue,
    startDebugRoiSampleCollection,
    stopDebugRoiSampleCollection,
} from "../../api/tauri";
import type { LootFont } from "../../recognition/lootFont";
import type { RoiOcrIssue } from "../../recognition/roiOcrDiagnostics";

export function formatSampleCollectionCountdown(deadline: number | null, now: number) {
    const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1_000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatSampleCollectionBytes(bytes: number) {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

/** Development-only ROI sample recording from native capture, plus the OCR issue log it is reviewed with. */
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
        if (run?.phase !== "running" || !run.path || captureToken === null || Date.now() >= (run.deadlineAtUnixMs ?? 0))
            return undefined;
        return { captureToken, collectionPath: run.path, batchId };
    }

    /** Stops tagging frames for a collection whose native capture has ended. */
    function forgetSampleCollection() {
        sampleCollectionRef.current = null;
    }

    async function toggleSampleCollection() {
        const captureToken = nativeCaptureToken.current;
        if (captureToken === null || sampleCollectionBusy) return;
        const revision = ++sampleCollectionRevision.current;
        setSampleCollectionBusy(true);
        setSampleCollectionError("");
        try {
            let next: DebugRoiSampleCollectionStatus;
            if (sampleCollection?.phase === "running") {
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
            if (mounted.current && revision === sampleCollectionRevision.current) setSampleCollectionBusy(false);
        }
    }

    return {
        sampleCollection,
        sampleCollectionBusy,
        sampleCollectionNow,
        sampleCollectionError: [sampleCollectionError, sampleDiagnosticError].filter(Boolean).join(" "),
        debugSampleCollectionAvailable,
        emitOcrIssue,
        sampleReference,
        forgetSampleCollection,
        toggleSampleCollection,
    };
}
