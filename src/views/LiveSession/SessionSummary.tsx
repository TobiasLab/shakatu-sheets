import { calculateTotals } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";

export function SessionMetrics({ controller, visible }: { controller: LiveSessionController; visible: boolean }) {
    const elapsedMs = useElapsedTime(controller.session, visible);
    const totals = calculateTotals(controller.session.entries, elapsedMs);
    return (
        <section className={styles.MetricsGrid} aria-label="Session summary">
            <article className={`${styles.Metric} ${styles.Primary}`}>
                <span>Net silver / hour</span>
                <strong>{formatSilver(totals.netPerHour, true)}</strong>
                <small>after market tax and expenses</small>
            </article>
            <article className={styles.Metric}>
                <span>Session net</span>
                <strong>{formatSilver(totals.net, true)}</strong>
                <small>{formatSilver(totals.net)} silver</small>
            </article>
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
        </section>
    );
}

export function SessionClock({ controller, visible }: { controller: LiveSessionController; visible: boolean }) {
    const { session, databaseLoaded, dispatch, setCompletedHours, startOrResume } = controller;
    const elapsedMs = useElapsedTime(session, visible);
    const timeEditable = session.status === "idle" || session.status === "paused";
    return (
        <section className={styles.SessionClock}>
            <div className={styles.ClockReadout}>
                <span>Session time</span>
                <time>{formatDuration(elapsedMs)}</time>
            </div>
            {timeEditable && (
                <details className={styles.ManualTime}>
                    <summary>Enter hours</summary>
                    <form className={styles.CompletedHours} onSubmit={setCompletedHours}>
                        <label>
                            <span>Completed hours</span>
                            <input
                                key={session.elapsedMs}
                                name="completedHours"
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
                    <button
                        className="button subtle"
                        type="button"
                        disabled={!databaseLoaded}
                        onClick={() => dispatch({ type: "finish", now: Date.now() })}
                    >
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
        </section>
    );
}
