import { useMemo } from "react";
import { calculateEntryTotals } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";

export function SessionMetrics({
    controller,
    visible,
    onFinish,
}: {
    controller: LiveSessionController;
    visible: boolean;
    onFinish: () => void;
}) {
    const elapsedMs = useElapsedTime(controller.session, visible);
    const entries = controller.session.entries;
    const totals = useMemo(() => calculateEntryTotals(entries), [entries]);
    const netPerHour = elapsedMs > 0 ? totals.net / (elapsedMs / 3_600_000) : 0;
    return (
        <section className={styles.MetricsGrid} aria-label="Session summary" aria-busy={!controller.databaseLoaded}>
            <article className={styles.Metric}>
                <span>Net silver / hour</span>
                <strong>{controller.databaseLoaded && elapsedMs > 0 ? formatSilver(netPerHour, true) : "—"}</strong>
                <small>{elapsedMs > 0 ? "After tax & expenses" : "Start timer or enter completed hours"}</small>
            </article>
            <article className={styles.Metric}>
                <span>Session net</span>
                <strong>{controller.databaseLoaded ? formatSilver(totals.net, true) : "—"}</strong>
                <details className={styles.Breakdown}>
                    <summary>Value breakdown</summary>
                    <dl>
                        <div>
                            <dt>Gross value</dt>
                            <dd>{formatSilver(totals.gross, true)}</dd>
                        </div>
                        <div>
                            <dt>Expenses</dt>
                            <dd>{formatSilver(totals.expenses, true)}</dd>
                        </div>
                        <div>
                            <dt>Tax & deductions</dt>
                            <dd>{formatSilver(totals.gross - totals.expenses - totals.net, true)}</dd>
                        </div>
                    </dl>
                </details>
            </article>
            <SessionClock controller={controller} elapsedMs={elapsedMs} onFinish={onFinish} />
        </section>
    );
}

function SessionClock({
    controller,
    elapsedMs,
    onFinish,
}: {
    controller: LiveSessionController;
    elapsedMs: number;
    onFinish: () => void;
}) {
    const { session, databaseLoaded, dispatch, setCompletedHours, startOrResume } = controller;
    const timeEditable = session.status === "idle" || session.status === "paused";
    return (
        <section className={styles.SessionClock}>
            <div className={styles.ClockReadout}>
                <span>Session time</span>
                <time>{databaseLoaded ? formatDuration(elapsedMs) : "—"}</time>
            </div>
            <div className={styles.ClockActions}>
                {session.status !== "running" && session.status !== "finished" && (
                    <button
                        className="button primary-button"
                        type="button"
                        disabled={!databaseLoaded}
                        onClick={startOrResume}
                    >
                        {session.status === "paused" ? "Resume timer" : "Start timer"}
                    </button>
                )}
                {session.status === "running" && (
                    <button
                        className="button"
                        type="button"
                        disabled={!databaseLoaded}
                        onClick={() => dispatch({ type: "pause", now: Date.now() })}
                    >
                        Pause timer
                    </button>
                )}
                {(session.status === "running" ||
                    session.status === "paused" ||
                    (session.status === "idle" && session.elapsedMs > 0)) && (
                    <button className="button subtle" type="button" disabled={!databaseLoaded} onClick={onFinish}>
                        Finish
                    </button>
                )}
                {session.status === "finished" && (
                    <button
                        className="button"
                        type="button"
                        disabled={!databaseLoaded}
                        onClick={() => dispatch({ type: "reset" })}
                    >
                        New session
                    </button>
                )}
            </div>
            {timeEditable && (
                <details className={styles.ManualTime}>
                    <summary>Enter hours</summary>
                    <form
                        className={styles.CompletedHours}
                        onSubmit={(event) => {
                            setCompletedHours(event);
                            const disclosure = event.currentTarget.closest("details");
                            if (disclosure) {
                                disclosure.open = false;
                                disclosure.querySelector("summary")?.focus();
                            }
                        }}
                    >
                        <label>
                            <span>Completed hours</span>
                            <input
                                key={session.elapsedMs}
                                name="completedHours"
                                max={Math.floor(Number.MAX_SAFE_INTEGER / 36_000) / 100}
                                type="number"
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                required
                                disabled={!databaseLoaded}
                                defaultValue={(session.elapsedMs / 3_600_000).toFixed(2)}
                            />
                        </label>
                        <button className="button" type="submit" disabled={!databaseLoaded}>
                            Save hours
                        </button>
                    </form>
                </details>
            )}
        </section>
    );
}
