import { useEffect, useMemo, useRef, useState } from "react";
import { loadSessionTrend } from "../../api/tauri";
import { Icon } from "../../components/Icon/Icon";
import { calculateEntryTotals } from "../../domain/session";
import type { TrendSample } from "../../domain/trend";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";
import { SessionTrend } from "./SessionTrend";

export function SessionMetrics({
    controller,
    saved,
    visible,
    onFinish,
}: {
    controller: LiveSessionController;
    saved: boolean;
    visible: boolean;
    onFinish: () => void;
}) {
    const elapsedMs = useElapsedTime(controller.session, visible);
    const entries = controller.session.entries;
    const totals = useMemo(() => calculateEntryTotals(entries), [entries]);
    const netPerHour = elapsedMs > 0 ? totals.net / (elapsedMs / 3_600_000) : 0;
    const { session, databaseLoaded } = controller;
    const [trend, setTrend] = useState<{ sessionId: string; samples: TrendSample[] }>({ sessionId: "", samples: [] });
    const trendRequest = useRef(0);
    // Every save that changes net records a sample, so reload once each save has finished.
    useEffect(() => {
        if (!databaseLoaded || !visible || !saved) return;
        const request = ++trendRequest.current;
        loadSessionTrend(session.id)
            .then((samples) => {
                if (request === trendRequest.current) setTrend({ sessionId: session.id, samples });
            })
            .catch(() => {
                if (request === trendRequest.current) setTrend({ sessionId: session.id, samples: [] });
            });
    }, [databaseLoaded, visible, saved, session.id]);
    return (
        <section
            className={styles.Readout}
            aria-label="Session summary"
            aria-busy={!controller.databaseLoaded}
            data-status={session.status}
        >
            <article className={`${styles.Metric} ${styles.PrimaryMetric}`}>
                <span>Net silver / hour</span>
                <strong>{controller.databaseLoaded && elapsedMs > 0 ? formatSilver(netPerHour, true) : "—"}</strong>
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
            <SessionTrend
                samples={trend.sessionId === session.id ? trend.samples : []}
                elapsedMs={elapsedMs}
                net={totals.net}
            />
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
    const elapsedSeconds = Math.round(session.elapsedMs / 1_000);
    return (
        <section className={styles.SessionClock} aria-label="Session time">
            <div className={`${styles.Metric} ${styles.ClockReadout}`}>
                <span>
                    Session time
                    {session.status === "paused" && <em className={styles.StateBadge}>Paused</em>}
                </span>
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
                        <Icon name="play" size={15} />
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
                        <Icon name="pause" size={15} />
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
                            <span>Hours</span>
                            <input
                                key={session.elapsedMs}
                                name="hours"
                                max={Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000)}
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                disabled={!databaseLoaded}
                                defaultValue={Math.floor(elapsedSeconds / 3_600)}
                            />
                        </label>
                        <label>
                            <span>Minutes</span>
                            <input
                                key={session.elapsedMs}
                                name="minutes"
                                type="number"
                                min="0"
                                max="59"
                                step="1"
                                inputMode="numeric"
                                disabled={!databaseLoaded}
                                defaultValue={Math.floor(elapsedSeconds / 60) % 60}
                            />
                        </label>
                        <label>
                            <span>Seconds</span>
                            <input
                                key={session.elapsedMs}
                                name="seconds"
                                type="number"
                                min="0"
                                max="59"
                                step="1"
                                inputMode="numeric"
                                disabled={!databaseLoaded}
                                defaultValue={elapsedSeconds % 60}
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
