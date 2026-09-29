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

const emptyModel = prepareQuantityLearning(emptyQuantityLearning);

export function useSelfImprovement() {
    const [state, setState] = useState(emptyQuantityLearning);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [failedExamples, setFailedExamples] = useState<QuantityExampleInput[]>([]);
    const [saveError, setSaveError] = useState("");
    const [message, setMessage] = useState("");
    const [announcement, setAnnouncement] = useState("");
    const [skippedExamples, setSkippedExamples] = useState(0);
    const alive = useRef(true);
    const pending = useRef(0);
    // Examples that are saving or failed, by id. A save finishing after Reset cannot miscount the queue.
    const unsaved = useRef(new Set<string>());
    const savingAllowed = useRef(false);
    const current = useRef(emptyQuantityLearning);
    const model = useRef(emptyModel);

    async function run(operation: LearningOperation) {
        if (operation.kind === "reset" || (operation.kind === "settings" && !operation.enabled))
            savingAllowed.current = false;
        pending.current += 1;
        setBusy(true);
        setError("");
        setMessage("");
        // Stop automatic recovery while settings or examples are being changed.
        model.current = emptyModel;
        try {
            const next = await quantityLearning(operation);
            if (!alive.current) return false;
            current.current = next;
            setState(next);
            setReady(true);
            return true;
        } catch (failure) {
            if (alive.current) {
                const reason = failure instanceof Error ? failure.message : String(failure);
                // A failed save stays with its unsaved example so its Retry and Discard never sit beside another error.
                if (operation.kind === "save") setSaveError(reason);
                else setError(`Self-improvement: ${reason}. Capture and session data are unaffected.`);
            }
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
        setAnnouncement("");
        if (await run({ kind: "save", example })) {
            unsaved.current.delete(example.id);
            setFailedExamples((current) => current.filter((saved) => saved.id !== example.id));
            setSaveError("");
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
        if (unsaved.current.size >= 50) {
            setSkippedExamples((count) => count + 1);
            return;
        }
        unsaved.current.add(example.id);
        void save(example);
    }

    return {
        state,
        ready,
        busy,
        error,
        saveError,
        skippedExamples,
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
        async deleteUnreadable() {
            for (const { id } of current.current.unreadable) if (!(await run({ kind: "delete", id }))) return;
        },
        async reset() {
            if (await run({ kind: "reset" })) {
                setFailedExamples([]);
                setSaveError("");
                setSkippedExamples(0);
                unsaved.current.clear();
                setMessage("Saved examples cleared. Self-improvement is off.");
            }
        },
        retrySave: () => {
            if (failedExamples[0]) void save(failedExamples[0]);
        },
        discardFailedSave: () => {
            if (failedExamples[0]) unsaved.current.delete(failedExamples[0].id);
            setFailedExamples((current) => current.slice(1));
            setSaveError("");
        },
        dismissSkipped: () => setSkippedExamples(0),
    };
}
