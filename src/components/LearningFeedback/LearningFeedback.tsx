import { useId } from "react";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
import { Feedback } from "../Feedback/Feedback";
import styles from "./LearningFeedback.module.css";

export function LearningFeedback({
    learning,
    onOpenSettings,
    className = "",
}: {
    learning: ReturnType<typeof useSelfImprovement>;
    onOpenSettings?: () => void;
    className?: string;
}) {
    const id = useId();
    const count = learning.failedExampleCount;
    const reason = learning.saveError ? ` (${learning.saveError.replace(/\.$/, "")})` : "";
    const settingsLink = onOpenSettings && (
        <button className="button subtle" type="button" onClick={onOpenSettings}>
            Self-improvement settings
        </button>
    );
    return (
        <>
            {(learning.error || learning.failedExample) && (
                <div className={`${styles.Notices} ${className}`}>
                    {learning.error && (
                        <Feedback tone="error" action={settingsLink}>
                            {learning.error}
                        </Feedback>
                    )}
                    {learning.failedExample && (
                        <Feedback
                            id={id}
                            tone="error"
                            action={
                                <div className={styles.Actions}>
                                    {learning.state.enabled ? (
                                        <button
                                            className="button"
                                            type="button"
                                            aria-describedby={id}
                                            disabled={learning.busy}
                                            onClick={learning.retrySave}
                                        >
                                            Retry save
                                        </button>
                                    ) : (
                                        settingsLink
                                    )}
                                    <button
                                        className="button subtle"
                                        type="button"
                                        aria-describedby={id}
                                        disabled={learning.busy}
                                        onClick={learning.discardFailedSave}
                                    >
                                        Discard
                                    </button>
                                </div>
                            }
                        >
                            {`${count === 1 ? "A learning example" : `${count} learning examples`} could not be saved${reason}. ${
                                count === 1 ? "Your drop was added." : "Your drops were added."
                            } ${learning.state.enabled ? "Retry before closing the app." : "Turn self-improvement on to retry."}`}
                        </Feedback>
                    )}
                </div>
            )}
            <div className="sr-only" aria-live="polite" aria-atomic="true">
                {learning.announcement}
            </div>
        </>
    );
}
