import { useEffect, useRef, useState } from "react";
import { type LearningOperation, quantityLearning } from "../api/quantityLearning";
import { supportsTauriApi } from "../api/tauri";
import type { LiveLootReviewEntry } from "../recognition/liveLootReview";
import {
    correctionQuantityExample,
    emptyQuantityLearning,
    prepareQuantityLearning,
    type QuantityExampleInput,
} from "../recognition/quantityLearning";

export function useSelfImprovement() {
    const [state, setState] = useState(emptyQuantityLearning);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [failedExamples, setFailedExamples] = useState<QuantityExampleInput[]>([]);
    const [message, setMessage] = useState("");
    const [announcement, setAnnouncement] = useState("");
    const alive = useRef(true);
    const pending = useRef(0);
    const queuedExamples = useRef(0);
    const savingAllowed = useRef(false);
    const current = useRef(emptyQuantityLearning);
    const model = useRef(prepareQuantityLearning(emptyQuantityLearning));

    async function run(operation: LearningOperation) {
        if (operation.kind === "reset" || (operation.kind === "settings" && !operation.enabled))
            savingAllowed.current = false;
        pending.current += 1;
        setBusy(true);
        setError("");
        setMessage("");
        // Stop automatic recovery while settings or examples are being changed.
        model.current = prepareQuantityLearning(emptyQuantityLearning);
        try {
            const next = await quantityLearning(operation);
            if (!alive.current) return false;
            current.current = next;
            setState(next);
            setReady(true);
            return true;
        } catch (failure) {
            if (alive.current)
                setError(`Self-improvement: ${String(failure)}. Capture and session data are unaffected.`);
            return false;
        } finally {
            pending.current -= 1;
            if (alive.current && pending.current === 0) {
                savingAllowed.current = current.current.enabled;
                model.current = prepareQuantityLearning(current.current);
                setBusy(false);
            }
        }
    }

    useEffect(() => {
        alive.current = true;
        if (supportsTauriApi()) void run({ kind: "load" });
        return () => {
            alive.current = false;
        };
    }, []);

    async function save(example: QuantityExampleInput) {
        if (await run({ kind: "save", example })) {
            queuedExamples.current -= 1;
            setFailedExamples((current) => current.filter((saved) => saved.id !== example.id));
            setAnnouncement("Correction saved for self-improvement.");
        } else if (alive.current) {
            setFailedExamples((current) =>
                current.some((saved) => saved.id === example.id) ? current : [...current, example],
            );
        }
    }

    function learnCorrection(review: LiveLootReviewEntry, quantity: number, itemName: string) {
        if (
            !savingAllowed.current ||
            review.source !== "normal" ||
            review.accepted ||
            (review.result.status !== "withheld" && review.result.status !== "failed") ||
            !review.learningProfile ||
            !review.learningId
        )
            return;
        setAnnouncement("");
        const example = correctionQuantityExample(review, quantity, itemName);
        if (!example) {
            setAnnouncement("Drop added. No clear, complete quantity crop was available to learn from.");
            return;
        }
        if (queuedExamples.current >= 50) {
            setError(
                "The drop was added, but the learning save queue is full. Retry or discard unsaved examples before teaching more.",
            );
            return;
        }
        queuedExamples.current += 1;
        void save(example);
    }

    return {
        state,
        ready,
        busy,
        error,
        message,
        announcement,
        model,
        failedExample: failedExamples[0] ?? null,
        failedExampleCount: failedExamples.length,
        available: supportsTauriApi(),
        learnCorrection,
        reload: () => run({ kind: "load" }),
        setSettings: (enabled: boolean, autoAllow: boolean) => run({ kind: "settings", enabled, autoAllow }),
        deleteExample: (id: string) => run({ kind: "delete", id }),
        async reset() {
            if (await run({ kind: "reset" })) {
                setFailedExamples([]);
                queuedExamples.current = 0;
                setMessage("Saved examples cleared. Self-improvement is off.");
            }
        },
        retrySave: () => {
            if (failedExamples[0]) void save(failedExamples[0]);
        },
        discardFailedSave: () => {
            if (failedExamples.length > 0) queuedExamples.current -= 1;
            setFailedExamples((current) => current.slice(1));
            setError("");
        },
    };
}
