import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
import type { LiveLootRecognitionResult } from "../../recognition/liveLoot";
import {
    acceptLiveLootReviewEntry,
    appendLiveLootReviewResult,
    correctLiveLootReviewEntry,
    type LiveLootReviewEntry,
} from "../../recognition/liveLootReview";

type AutomaticRetry = { timerId: number; retriesRemaining: number };

const AUTOMATIC_INSERTION_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

export function resultDescription(result: LiveLootRecognitionResult) {
    if (result.status === "recognized")
        return `${result.itemName} x ${result.quantity}${result.learnedQuantity ? " (self-improvement)" : ""}`;
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
    if (entry.accepted && entry.result.status !== "recognized")
        return `Result ${entry.id + 1}, ${source}: Added to the session.`;
    if (entry.error && entry.result.status !== "recognized") return `Result ${entry.id + 1}, ${source}: ${entry.error}`;
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

/** Recognition results awaiting insertion: automatic insertion with retries, manual retry, correction, dismissal. */
export function useLiveLootReviewQueue({
    sessionId,
    sessionActive,
    databaseLoaded,
    learning,
    onAcceptRecognition,
}: {
    sessionId: string;
    sessionActive: boolean;
    databaseLoaded: boolean;
    learning: ReturnType<typeof useSelfImprovement>;
    onAcceptRecognition: (itemName: string, quantity: number, source?: "manual" | "recognition") => string | null;
}) {
    const mounted = useRef(true);
    const activeSessionId = useRef(sessionId);
    const onAcceptRecognitionRef = useRef(onAcceptRecognition);
    const nextReviewResultId = useRef(0);
    const reviewResultsRef = useRef<LiveLootReviewEntry[]>([]);
    const automaticRetries = useRef(new Map<number, AutomaticRetry>());
    const manualRetryAttempts = useRef(new Map<number, number>());
    const [reviewResults, setReviewResults] = useState<LiveLootReviewEntry[]>([]);
    const [omittedReviewResults, setOmittedReviewResults] = useState(0);
    const [recognitionAnnouncement, setRecognitionAnnouncement] = useState("");

    useLayoutEffect(() => {
        activeSessionId.current = sessionId;
        onAcceptRecognitionRef.current = onAcceptRecognition;
    }, [onAcceptRecognition, sessionId]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            clearAutomaticRetries();
        };
    }, []);

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

    /** Inserts a new result automatically when it was recognized, and queues it for review. */
    function addReviewResult(result: Omit<LiveLootReviewEntry, "id" | "accepted" | "error">) {
        const id = nextReviewResultId.current;
        nextReviewResultId.current += 1;
        const entry = acceptLiveLootReviewEntry(
            { id, ...result, accepted: false, error: "" },
            onAcceptRecognitionRef.current,
        );
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

    function correctReviewResult(id: number, itemName: string, quantity: number) {
        if (!sessionActive || !databaseLoaded) return;
        const review = reviewResultsRef.current.find((entry) => entry.id === id);
        if (!review) return;
        const corrected = correctLiveLootReviewEntry(review, itemName, quantity, (name, count) =>
            onAcceptRecognitionRef.current(name, count, "manual"),
        );
        replaceReviewEntry(corrected);
        if (!review.accepted && corrected.accepted) {
            cancelAutomaticRetry(id);
            learning.learnCorrection(review, quantity, itemName);
        }
    }

    function dismissReviewResult(id: number) {
        cancelAutomaticRetry(id);
        manualRetryAttempts.current.delete(id);
        const next = reviewResultsRef.current.filter((entry) => entry.id !== id);
        reviewResultsRef.current = next;
        setReviewResults(next);
        setRecognitionAnnouncement("Dismissed review entry. Session loot is unchanged.");
    }

    function clearReviewResults() {
        clearAutomaticRetries();
        manualRetryAttempts.current.clear();
        reviewResultsRef.current = [];
        setReviewResults([]);
        setOmittedReviewResults(0);
        setRecognitionAnnouncement("");
    }

    /** Starts result numbering again, for a new session or grind spot. */
    function resetReviewResults() {
        nextReviewResultId.current = 0;
        clearReviewResults();
    }

    function unacceptedReviewCount() {
        return reviewResultsRef.current.filter((entry) => !entry.accepted).length;
    }

    return {
        reviewResults,
        omittedReviewResults,
        recognitionAnnouncement,
        addReviewResult,
        acceptReviewResult,
        correctReviewResult,
        dismissReviewResult,
        clearReviewResults,
        resetReviewResults,
        clearAutomaticRetries,
        unacceptedReviewCount,
    };
}
