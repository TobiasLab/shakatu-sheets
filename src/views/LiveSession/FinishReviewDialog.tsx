import type { RefObject } from "react";
import { DialogHeader } from "../../components/Dialog/DialogHeader";
import { Feedback } from "../../components/Feedback/Feedback";
import { Icon } from "../../components/Icon/Icon";
import styles from "./FinishReviewDialog.module.css";

export function FinishReviewDialog({
    dialogRef,
    preparing,
    error,
    unresolvedCount,
    canFinish,
    onKeepOpen,
    onReview,
    onFinish,
}: {
    dialogRef: RefObject<HTMLDialogElement | null>;
    preparing: boolean;
    error: string;
    unresolvedCount: number;
    canFinish: boolean;
    onKeepOpen: () => void;
    onReview: () => void;
    onFinish: () => void;
}) {
    const hasUnreviewedDrops = unresolvedCount > 0;
    const readyToFinish = !preparing && !error;
    let summary = "All captured drops reviewed";
    let description = "Your session is ready to finish.";
    if (preparing) {
        summary = "Checking the last captures";
        description = "The timer is paused while reading finishes.";
    } else if (error) {
        summary = "Your session is still open";
        description = "Keep the session open and try finishing again.";
    } else if (hasUnreviewedDrops) {
        summary = `${unresolvedCount} ${unresolvedCount === 1 ? "entry needs" : "entries need"} review`;
        description = "These drops are not included in your session totals.";
    }

    return (
        <dialog
            ref={dialogRef}
            className={styles.Dialog}
            aria-labelledby="finish-review-title"
            aria-describedby="finish-review-description"
            onCancel={onKeepOpen}
        >
            <DialogHeader
                titleId="finish-review-title"
                title={preparing ? "Reading final drops…" : "Review before finishing"}
                closeLabel="Close finish review"
                onClose={onKeepOpen}
            />
            <div className={styles.Body}>
                <div className={styles.Summary}>
                    <span className={styles.Count} aria-hidden="true">
                        {preparing ? (
                            <Icon name="capture" size={24} />
                        ) : error ? (
                            <Icon name="pause" size={24} />
                        ) : (
                            unresolvedCount
                        )}
                    </span>
                    <div role="status">
                        <strong>{summary}</strong>
                        <p id="finish-review-description">{description}</p>
                    </div>
                </div>
                {preparing && <progress className={styles.Progress} aria-label="Reading final captures" />}
                {error && <Feedback tone="error">{error}</Feedback>}
            </div>
            <footer className={styles.Actions}>
                <button type="button" className="button" onClick={onKeepOpen}>
                    Keep session open
                </button>
                {!preparing && hasUnreviewedDrops && (
                    <button type="button" className="button primary-button" onClick={onReview}>
                        Review drops <Icon name="arrow" size={16} />
                    </button>
                )}
                {readyToFinish && !hasUnreviewedDrops && (
                    <button type="button" className="button primary-button" disabled={!canFinish} onClick={onFinish}>
                        Finish session
                    </button>
                )}
            </footer>
            {readyToFinish && hasUnreviewedDrops && (
                <div className={styles.Discard}>
                    <span>Unreviewed captures will be discarded.</span>
                    <button type="button" className="button subtle" disabled={!canFinish} onClick={onFinish}>
                        Finish without adding these drops
                    </button>
                </div>
            )}
        </dialog>
    );
}
