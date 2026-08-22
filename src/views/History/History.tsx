import { useEffect, useState } from "react";
import { type FinishedSessionRecord, listFinishedSessions } from "../../api/tauri";
import { sycraiaLower } from "../../data/grindSpots";
import { calculateTotals } from "../../domain/session";
import { formatDuration, formatSilver, formatTimestamp } from "../../format";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import styles from "./History.module.css";

export function HistoryView({
    databaseLoaded,
    databaseStatus,
    onReopen,
}: {
    databaseLoaded: boolean;
    databaseStatus: DatabaseStatus;
    onReopen: (id: string) => Promise<void>;
}) {
    const [records, setRecords] = useState<FinishedSessionRecord[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [reopenError, setReopenError] = useState("");
    const [reopening, setReopening] = useState(false);

    async function loadHistory() {
        setRecords(null);
        setError("");
        try {
            const finished = await listFinishedSessions();
            setRecords(finished);
            setSelectedId((current) =>
                finished.some((record) => record.session.id === current) ? current : (finished[0]?.session.id ?? null),
            );
        } catch (loadError) {
            setRecords([]);
            setError(String(loadError));
        }
    }

    useEffect(() => {
        if (databaseLoaded && databaseStatus !== "saving") loadHistory();
    }, [databaseLoaded, databaseStatus]);

    const selected = records?.find((record) => record.session.id === selectedId) ?? records?.[0];
    const selectedTotals = selected ? calculateTotals(selected.session.entries, selected.session.elapsedMs) : null;

    async function reopenSelected() {
        if (!selected) return;
        setReopening(true);
        setReopenError("");
        try {
            await onReopen(selected.session.id);
        } catch (reopenFailure) {
            setReopenError(String(reopenFailure));
            setReopening(false);
        }
    }

    return (
        <>
            <header className="topbar">
                <div>
                    <p className="eyebrow">Completed sessions</p>
                    <h1>Session history</h1>
                </div>
                <button className="button subtle" type="button" disabled={!databaseLoaded} onClick={loadHistory}>
                    Reload
                </button>
            </header>

            {!databaseLoaded || records === null ? (
                <section className={`panel ${styles.HistoryMessage}`}>
                    <strong>Reading completed sessions...</strong>
                </section>
            ) : error ? (
                <section className={`panel ${styles.HistoryMessage} ${styles.ErrorMessage}`}>
                    <strong>Could not load session history</strong>
                    <p>{error}</p>
                </section>
            ) : records.length === 0 ? (
                <section className={`panel empty-state ${styles.HistoryMessage}`}>
                    <div className="empty-glyph">0</div>
                    <strong>No completed sessions yet</strong>
                    <p>Finish a live session and it will appear here.</p>
                </section>
            ) : (
                <div className={styles.HistoryGrid}>
                    <section className="panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Recent ledger</p>
                                <h2>Last {records.length} sessions</h2>
                            </div>
                        </div>
                        <div className={styles.HistoryList}>
                            {records.map((record) => {
                                const totals = calculateTotals(record.session.entries, record.session.elapsedMs);
                                return (
                                    <button
                                        className={record.session.id === selected?.session.id ? styles.Selected : ""}
                                        type="button"
                                        key={record.session.id}
                                        onClick={() => {
                                            setSelectedId(record.session.id);
                                            setReopenError("");
                                        }}
                                    >
                                        <span>
                                            <strong>{formatTimestamp(record.finishedAt)}</strong>
                                            <small>
                                                {record.session.region.toUpperCase()} ·{" "}
                                                {formatDuration(record.session.elapsedMs)}
                                            </small>
                                        </span>
                                        <span className={styles.HistoryValue}>
                                            <strong>{formatSilver(totals.netPerHour, true)}/h</strong>
                                            <small>{formatSilver(totals.net, true)} net</small>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    {selected && selectedTotals && (
                        <section className="panel">
                            <div className="panel-heading">
                                <div>
                                    <p className="eyebrow">Session detail</p>
                                    <h2>{sycraiaLower.name}</h2>
                                </div>
                                <div className={styles.DetailActions}>
                                    <span>{selected.session.region.toUpperCase()}</span>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={!databaseLoaded || databaseStatus === "saving" || reopening}
                                        onClick={reopenSelected}
                                    >
                                        {reopening ? "Reopening..." : "Reopen"}
                                    </button>
                                </div>
                            </div>
                            {reopenError && (
                                <p className={styles.ReopenError} role="alert">
                                    {reopenError}
                                </p>
                            )}
                            <div className={styles.HistorySummary}>
                                <div>
                                    <span>Duration</span>
                                    <strong>{formatDuration(selected.session.elapsedMs)}</strong>
                                </div>
                                <div>
                                    <span>Session net</span>
                                    <strong>{formatSilver(selectedTotals.net, true)}</strong>
                                </div>
                                <div>
                                    <span>Net / hour</span>
                                    <strong>{formatSilver(selectedTotals.netPerHour, true)}</strong>
                                </div>
                            </div>
                            {selected.session.entries.length === 0 ? (
                                <div className={`empty-state ${styles.HistoryEntriesEmpty}`}>
                                    <strong>No entries recorded</strong>
                                </div>
                            ) : (
                                <div className={styles.HistoryEntries}>
                                    {selected.session.entries.map((entry) => (
                                        <div className={styles.HistoryEntry} key={entry.id}>
                                            <div className={`item-swatch ${entry.valuation}`}>
                                                {entry.valuation === "expense" ? "-" : "+"}
                                            </div>
                                            <span>
                                                <strong>{entry.name}</strong>
                                                <small>
                                                    x{formatSilver(entry.quantity)} · {formatSilver(entry.unitPrice)}{" "}
                                                    each
                                                </small>
                                            </span>
                                            <strong className={entry.valuation === "expense" ? "negative" : ""}>
                                                {entry.valuation === "expense" ? "-" : ""}
                                                {formatSilver(entry.quantity * entry.unitPrice, true)}
                                            </strong>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    )}
                </div>
            )}
        </>
    );
}
