import { useEffect, useRef, useState } from "react";
import { type LiveLootReviewEntry, readItemName } from "../../recognition/liveLootReview";
import { itemImage, quantityImage } from "../../recognition/quantityLearning";
import { FormField } from "../FormField/FormField";
import { CaptureCorrection, type CorrectionDraft } from "./CaptureCorrection";
import styles from "./LootReview.module.css";
import type { useLiveLootCapture } from "./useLiveLootCapture";

type ReviewController = Pick<
    ReturnType<typeof useLiveLootCapture>,
    | "reviewResults"
    | "omittedReviewResults"
    | "clearReviewResults"
    | "dismissReviewResult"
    | "resultDescription"
    | "acceptReviewResult"
    | "correctReviewResult"
    | "itemDictionary"
    | "databaseLoaded"
    | "sessionStatus"
> & {
    learning?: ReturnType<typeof useLiveLootCapture>["learning"];
    onOpenSelfImprovement?: () => void;
    ignoreReviewItem?: ReturnType<typeof useLiveLootCapture>["ignoreReviewItem"];
};

export function focusLootReview() {
    const heading = document.getElementById("loot-review-heading");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
}

function reviewTitle(review: LiveLootReviewEntry) {
    const result = review.result;
    if (result.status === "recognized") return `${result.itemName} × ${result.quantity}`;
    if (result.status === "failed") return "Unreadable capture";
    if (result.status === "dropped") return `${result.count} unprocessed notifications`;
    if (result.reason === "quantity-not-recognized") return "Check quantity";
    if (result.reason === "item-not-recognized") return "Identify item";
    if (result.reason === "insufficient-observations") return "Capture too brief";
    return "Check item and quantity";
}

export function LootReview({ controller }: { controller: ReviewController }) {
    const pending = controller.reviewResults.filter((entry) => !entry.accepted).sort((a, b) => a.id - b.id);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [drafts, setDrafts] = useState<Record<number, CorrectionDraft>>({});
    const [confirmClear, setConfirmClear] = useState(false);
    const [ignoring, setIgnoring] = useState<{ id: number; name: string; error: string; saving: boolean } | null>(null);
    const clearButton = useRef<HTMLButtonElement>(null);
    const hadFocus = useRef(false);
    const selected =
        pending.find((entry) => entry.id === selectedId) ??
        pending.find((entry) => entry.id > (selectedId ?? -1)) ??
        pending[pending.length - 1];
    const disabled = !controller.databaseLoaded || controller.sessionStatus === "finished";

    useEffect(() => {
        if (selectedId !== (selected?.id ?? null)) {
            setSelectedId(selected?.id ?? null);
            if (hadFocus.current && selectedId !== null) {
                const target = selected
                    ? document.getElementById(`review-select-${selected.id}`)
                    : document.getElementById("live-capture-heading");
                target?.focus({ preventScroll: true });
                const queue = target?.closest("ul");
                if (queue && target) {
                    const rowBounds = target.getBoundingClientRect();
                    const queueBounds = queue.getBoundingClientRect();
                    queue.scrollTop +=
                        rowBounds.top < queueBounds.top
                            ? rowBounds.top - queueBounds.top
                            : Math.max(0, rowBounds.bottom - queueBounds.bottom);
                }
            }
        }
        if (pending.length === 0 && selectedId !== null) {
            setDrafts({});
            setConfirmClear(false);
        }
    }, [controller.reviewResults, selectedId]);

    if (!selected) return null;
    const status = selected.result.status;
    const learning =
        controller.learning?.state.enabled && selected.source === "normal" && selected.result.status !== "dropped"
            ? { model: controller.learning.model.current, profile: selected.learningProfile }
            : undefined;
    let draft = drafts[selected.id];
    if (!draft && selected.result.status !== "dropped") {
        // A match on the saved crop uses the current library, so deleted or newly taught examples count. The
        // capture-time suggestion fills what it lacks: a match from another selected frame or a clear OCR majority.
        const stored = learning ? selected.result.quantitySuggestion : undefined;
        const image = quantityImage(selected.result.capture);
        const nameImage = itemImage(selected.result.capture);
        const learnedQuantity =
            (learning?.profile && image ? learning.model.suggest(image, learning.profile)?.quantity : undefined) ??
            stored?.quantity ??
            undefined;
        const learnedItem =
            (learning?.profile && nameImage
                ? learning.model.suggestItem(nameImage, learning.profile, controller.itemDictionary)?.itemName
                : undefined) ??
            (stored?.itemName && controller.itemDictionary.includes(stored.itemName) ? stored.itemName : undefined);
        draft = {
            item: learnedItem ?? "",
            quantity: String(learnedQuantity ?? 1),
            learnedItem,
            learnedQuantity,
        };
        if (learnedQuantity !== undefined || learnedItem !== undefined) {
            setDrafts({ ...drafts, [selected.id]: draft });
        }
    }
    return (
        <section
            data-review
            className={styles.Review}
            aria-labelledby="loot-review-heading"
            onFocusCapture={() => {
                hadFocus.current = true;
            }}
            onBlurCapture={(event) => {
                hadFocus.current = event.currentTarget.contains(event.relatedTarget as Node | null);
            }}
        >
            <header className={styles.Header}>
                <h3 id="loot-review-heading" tabIndex={-1}>
                    Needs attention <span className={styles.Count}>{pending.length}</span>
                </h3>
                <button
                    className="button subtle"
                    type="button"
                    ref={clearButton}
                    onClick={() => setConfirmClear(!confirmClear)}
                    aria-expanded={confirmClear}
                >
                    Dismiss all
                </button>
            </header>
            {confirmClear && (
                <div className={styles.ClearConfirmation}>
                    <p>Discard all {pending.length} unreviewed captures? Ledger entries will stay.</p>
                    <div>
                        <button
                            className="button"
                            type="button"
                            onClick={() => {
                                setConfirmClear(false);
                                clearButton.current?.focus();
                            }}
                        >
                            Keep captures
                        </button>
                        <button
                            className="button"
                            type="button"
                            onClick={() => {
                                controller.clearReviewResults();
                                setConfirmClear(false);
                                document.getElementById("live-capture-heading")?.focus();
                            }}
                        >
                            Discard captures
                        </button>
                    </div>
                </div>
            )}
            <div className={styles.Workspace}>
                <ul className={styles.Queue} aria-label="Unreviewed captures">
                    {pending.map((review, index) => (
                        <li key={review.id} data-review-entry={review.id}>
                            <button
                                id={`review-select-${review.id}`}
                                type="button"
                                aria-pressed={review.id === selected.id}
                                aria-controls="loot-review-detail"
                                tabIndex={review.id === selected.id ? 0 : -1}
                                onClick={() => setSelectedId(review.id)}
                                onKeyDown={(event) => {
                                    let nextIndex: number;
                                    switch (event.key) {
                                        case "ArrowDown":
                                            nextIndex = Math.min(index + 1, pending.length - 1);
                                            break;
                                        case "ArrowUp":
                                            nextIndex = Math.max(0, index - 1);
                                            break;
                                        case "Home":
                                            nextIndex = 0;
                                            break;
                                        case "End":
                                            nextIndex = pending.length - 1;
                                            break;
                                        default:
                                            return;
                                    }
                                    event.preventDefault();
                                    const next = pending[nextIndex];
                                    setSelectedId(next.id);
                                    document.getElementById(`review-select-${next.id}`)?.focus();
                                }}
                            >
                                <span className={styles.QueueMeta}>
                                    <span>{review.source === "normal" ? "Normal loot" : "Rare banner"}</span>
                                    <span>#{review.id + 1}</span>
                                </span>
                                <strong>{reviewTitle(review)}</strong>
                                {review.result.status === "recognized" && (
                                    <span className={styles.Ready}>Ready to add</span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
                <section id="loot-review-detail" className={styles.Detail} aria-labelledby="review-detail-title">
                    <header className={styles.DetailHeader}>
                        <div>
                            <span className={styles.DetailMeta}>
                                {selected.source === "normal" ? "Normal loot" : "Rare banner"} · #{selected.id + 1}
                            </span>
                            <h4 id="review-detail-title">{reviewTitle(selected)}</h4>
                        </div>
                        <div className={styles.DetailActions}>
                            {status === "withheld" && controller.ignoreReviewItem && (
                                <button
                                    className="button subtle"
                                    type="button"
                                    aria-expanded={ignoring?.id === selected.id}
                                    disabled={disabled}
                                    onClick={() =>
                                        setIgnoring(
                                            ignoring?.id === selected.id
                                                ? null
                                                : {
                                                      id: selected.id,
                                                      name: readItemName(selected),
                                                      error: "",
                                                      saving: false,
                                                  },
                                        )
                                    }
                                >
                                    Ignore item
                                </button>
                            )}
                            <button
                                className="button subtle"
                                type="button"
                                aria-label={`Dismiss review entry ${selected.id + 1}`}
                                onClick={() => controller.dismissReviewResult(selected.id)}
                            >
                                Dismiss
                            </button>
                        </div>
                    </header>
                    {status !== "recognized" && (
                        <p className={styles.Reason}>{controller.resultDescription(selected.result)}</p>
                    )}
                    {ignoring?.id === selected.id && controller.ignoreReviewItem && (
                        <form
                            className={styles.IgnoreForm}
                            onSubmit={async (event) => {
                                event.preventDefault();
                                if (!controller.ignoreReviewItem || ignoring.saving) return;
                                setIgnoring({ ...ignoring, error: "", saving: true });
                                // A failed save keeps the form open with its reason and dismisses nothing.
                                const error = await controller.ignoreReviewItem(selected.id, ignoring.name);
                                setIgnoring((current) =>
                                    current?.id !== ignoring.id
                                        ? current
                                        : error
                                          ? { ...current, error, saving: false }
                                          : null,
                                );
                            }}
                        >
                            <FormField label="Item to ignore" className={styles.ItemField}>
                                <input
                                    value={ignoring.name}
                                    maxLength={100}
                                    required
                                    placeholder="Exact in-game name"
                                    onChange={(event) =>
                                        setIgnoring({ ...ignoring, name: event.target.value, error: "" })
                                    }
                                    disabled={ignoring.saving}
                                />
                            </FormField>
                            <button className="button" type="submit" disabled={disabled || ignoring.saving}>
                                {ignoring.saving ? "Saving…" : "Ignore"}
                            </button>
                            {ignoring.error && (
                                <p className={styles.Error} role="alert">
                                    {ignoring.error}
                                </p>
                            )}
                        </form>
                    )}
                    {selected.error && (
                        <p className={styles.Error} role="alert">
                            {selected.error}
                        </p>
                    )}
                    {(status === "withheld" || status === "failed") && (
                        <CaptureCorrection
                            key={selected.id}
                            review={selected}
                            items={controller.itemDictionary}
                            disabled={disabled}
                            draft={draft}
                            onDraftChange={(draft) => setDrafts((current) => ({ ...current, [selected.id]: draft }))}
                            onAdd={controller.correctReviewResult}
                            learnOnAdd={!!learning?.profile && controller.learning?.ready}
                        />
                    )}
                    {status === "recognized" && (
                        <div className={styles.ReadyAction}>
                            <p>This drop was recognized but has not been added to the session.</p>
                            <button
                                className="button primary-button"
                                type="button"
                                disabled={disabled}
                                onClick={() => controller.acceptReviewResult(selected.id)}
                            >
                                Retry add
                            </button>
                        </div>
                    )}
                    {status === "dropped" && (
                        <p className={styles.Unavailable}>
                            No capture was retained. Use Add loot or expense to record any missing items.
                        </p>
                    )}
                </section>
            </div>
            <footer className={styles.Footer}>
                <span>Unreviewed drops are not in your totals.</span>
                {controller.onOpenSelfImprovement && (
                    <button className="button subtle" type="button" onClick={controller.onOpenSelfImprovement}>
                        Self-improvement settings
                    </button>
                )}
                {controller.omittedReviewResults > 0 && (
                    <span role="status">
                        {controller.omittedReviewResults} older results removed. Unresolved item captures are retained.
                    </span>
                )}
            </footer>
        </section>
    );
}
