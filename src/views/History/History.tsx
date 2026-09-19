import { useEffect, useRef, useState } from "react";
import {
    applyFinishedSessionConsumables,
    deleteFinishedSession,
    type FinishedSessionRecord,
    type GarmothSettings,
    type HistoryResult,
    listFinishedSessions,
    loadGarmothSettings,
    uploadGarmothSession,
} from "../../api/tauri";
import { ConsumablePresetPicker } from "../../components/ConsumablePresets/ConsumablePresetPicker";
import { getDropIcon, grindSpots } from "../../data/grindSpots";
import { historyDateBoundary, netPerHour, rankSpots, summarizeHistory } from "../../domain/history";
import { calculateTotals, type SessionEntry, type SessionState } from "../../domain/session";
import { formatDuration, formatSilver, formatTimestamp } from "../../format";
import { buildGarmothUpload, type GarmothUploadPreview } from "../../garmoth";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import dialogStyles from "../LiveSession/LiveSession.module.css";
import styles from "./History.module.css";

function spotName(id: string) {
    return grindSpots.find((spot) => spot.id === id)?.name ?? id;
}

export function HistoryView({
    initialRegion,
    databaseLoaded,
    databaseStatus,
    onReopen,
    onOpenSettings,
    onSessionCorrected,
}: {
    initialRegion: "eu" | "na";
    databaseLoaded: boolean;
    databaseStatus: DatabaseStatus;
    onReopen: (id: string) => Promise<void>;
    onOpenSettings: () => void;
    onSessionCorrected: (session: SessionState) => void;
}) {
    const [records, setRecords] = useState<FinishedSessionRecord[] | null>(null);
    const [history, setHistory] = useState<HistoryResult | null>(null);
    const [selectedRegion, setRegion] = useState<"eu" | "na" | null>(null);
    const region = selectedRegion ?? initialRegion;
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [reopenError, setReopenError] = useState("");
    const [reopening, setReopening] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState("");
    const [deleteMessage, setDeleteMessage] = useState("");
    const [restoreFocus, setRestoreFocus] = useState<{
        sessionId: string | null;
        target: "select" | "delete";
    } | null>(null);
    const [grindSpotFilter, setGrindSpotFilter] = useState("all");
    const [garmothSettings, setGarmothSettings] = useState<GarmothSettings | null>(null);
    const [applyingConsumables, setApplyingConsumables] = useState(false);
    const [consumableMessage, setConsumableMessage] = useState("");
    const [uploading, setUploading] = useState(false);
    const [uploadMessage, setUploadMessage] = useState("");
    const [uploadError, setUploadError] = useState("");
    const [settingsError, setSettingsError] = useState("");
    const [garmothSettingsLoaded, setGarmothSettingsLoaded] = useState(false);
    const reloadButton = useRef<HTMLButtonElement>(null);
    const filterDialog = useRef<HTMLDialogElement>(null);
    const filterButton = useRef<HTMLButtonElement>(null);
    const regionInput = useRef<HTMLSelectElement>(null);
    const historySelectButtons = useRef(new Map<string, HTMLButtonElement>());
    const historyDeleteButtons = useRef(new Map<string, HTMLButtonElement>());
    const historyRequestId = useRef(0);
    const previousButton = useRef<HTMLButtonElement>(null);
    const nextButton = useRef<HTMLButtonElement>(null);
    const pageFocus = useRef<"previous" | "next" | null>(null);

    async function loadHistory(showLoading = true) {
        const requestId = ++historyRequestId.current;
        setLoading(true);
        if (showLoading) {
            setRecords(null);
            setHistory(null);
            setDeleteError("");
            setDeleteMessage("");
        }
        setError("");
        try {
            const finishedFromMs = historyDateBoundary(fromDate);
            const finishedBeforeMs = historyDateBoundary(toDate, true);
            if (finishedFromMs !== null && finishedBeforeMs !== null && finishedFromMs >= finishedBeforeMs) {
                throw new Error("The From date must be on or before the To date.");
            }
            const result = await listFinishedSessions({
                region,
                grindSpotId: grindSpotFilter === "all" ? null : grindSpotFilter,
                finishedFromMs,
                finishedBeforeMs,
                offset,
                limit: 20,
            });
            const finished = result.records;
            if (requestId !== historyRequestId.current) return "";
            setRecords(finished);
            setHistory(result);
            setSelectedId((current) =>
                finished.some((record) => record.session.id === current) ? current : (finished[0]?.session.id ?? null),
            );
            return "";
        } catch (loadError) {
            if (requestId !== historyRequestId.current) return "";
            const detail = String(loadError);
            if (showLoading) setRecords([]);
            setHistory(null);
            setError(detail);
            return detail;
        } finally {
            if (requestId === historyRequestId.current) setLoading(false);
        }
    }

    useEffect(() => {
        if (databaseLoaded && databaseStatus !== "saving") void loadHistory();
        return () => {
            historyRequestId.current += 1;
        };
    }, [databaseLoaded, databaseStatus, region, fromDate, toDate, grindSpotFilter, offset]);

    useEffect(() => {
        if (databaseLoaded) {
            setGarmothSettingsLoaded(false);
            loadGarmothSettings()
                .then((loaded) => {
                    setGarmothSettings(loaded);
                    setSettingsError("");
                })
                .catch((failure) => {
                    setGarmothSettings(null);
                    setSettingsError(String(failure));
                })
                .finally(() => setGarmothSettingsLoaded(true));
        }
    }, [databaseLoaded]);

    const pageRecords = records ?? [];
    const historyTotals = summarizeHistory(
        history?.spotSummaries ?? [],
        grindSpotFilter === "all" ? null : grindSpotFilter,
    );
    const trackedMs = historyTotals.elapsedMs;
    const historyRate = netPerHour(historyTotals);
    const comparisonSpots = rankSpots(history?.spotSummaries ?? []);
    const selected = pageRecords.find((record) => record.session.id === selectedId) ?? pageRecords[0];
    const selectedTotals = selected ? calculateTotals(selected.session.entries, selected.session.elapsedMs) : null;
    let uploadPreview: GarmothUploadPreview | null = null;
    let uploadPreviewError = "";
    if (selected) {
        try {
            uploadPreview = buildGarmothUpload(selected.session);
        } catch (previewFailure) {
            uploadPreviewError = String(previewFailure);
        }
    }
    const uploadCharacter = garmothSettings?.characters.find(
        (character) => character.id === garmothSettings.selectedCharacterId,
    );
    const actionBusy = uploading || reopening || deletingId !== null || applyingConsumables;
    const activeFilterCount = Number(Boolean(fromDate || toDate)) + Number(grindSpotFilter !== "all");

    useEffect(() => {
        if (!databaseLoaded || actionBusy) filterDialog.current?.close();
    }, [databaseLoaded, actionBusy]);

    function resetPage() {
        setOffset(0);
        setSelectedId(null);
        setReopenError("");
        setDeleteError("");
        setUploadMessage("");
        setUploadError("");
    }

    function selectSpot(id: string) {
        resetPage();
        setGrindSpotFilter(id);
    }

    function changePage(nextOffset: number) {
        pageFocus.current = nextOffset < (history?.offset ?? 0) ? "previous" : "next";
        setOffset(nextOffset);
        setSelectedId(null);
        setReopenError("");
        setUploadMessage("");
        setUploadError("");
    }

    useEffect(() => {
        if (!pageFocus.current || loading || records === null) return;
        const button = pageFocus.current === "previous" ? previousButton.current : nextButton.current;
        const target =
            button && !button.disabled
                ? button
                : (historySelectButtons.current.get(records[0]?.session.id) ?? reloadButton.current);
        target?.focus();
        pageFocus.current = null;
    }, [loading, records]);

    useEffect(() => {
        if (!restoreFocus || deletingId !== null) return;
        const target = restoreFocus.sessionId
            ? ((restoreFocus.target === "select" ? historySelectButtons : historyDeleteButtons).current.get(
                  restoreFocus.sessionId,
              ) ?? reloadButton.current)
            : (historySelectButtons.current.get(pageRecords[0]?.session.id) ?? reloadButton.current);
        if (!target) return;
        target.focus();
        setRestoreFocus(null);
    }, [deletingId, restoreFocus, pageRecords]);

    useEffect(() => {
        setConsumableMessage("");
    }, [selected?.session.id]);

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

    async function applyConsumables(snapshot: SessionState, entries: SessionEntry[]) {
        if (actionBusy) throw new Error("Wait for the current session action to finish.");
        const record = pageRecords.find((candidate) => candidate.session.id === snapshot.id);
        if (!record || record.garmothUploadStatus === "unknown") throw new Error("This session cannot be changed.");
        const total = entries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0);
        if (
            !window.confirm(
                `Apply ${formatSilver(total)} silver in consumable expenses to ${spotName(snapshot.grindSpotId)} from ${formatTimestamp(record.finishedAt)}? ${record.garmothUploadStatus === "success" ? "The previous Garmoth session will not change." : "Existing consumable expenses will be replaced."}`,
            )
        )
            return false;
        historyRequestId.current += 1;
        setApplyingConsumables(true);
        setConsumableMessage("");
        try {
            const updated = await applyFinishedSessionConsumables(snapshot, entries);
            onSessionCorrected(updated);
            setRecords(
                (current) =>
                    current?.map((candidate) =>
                        candidate.session.id === updated.id ? { ...candidate, session: updated } : candidate,
                    ) ?? null,
            );
            const refreshError = await loadHistory(false);
            setConsumableMessage(
                refreshError
                    ? "Consumables saved. Reload History to refresh totals."
                    : "Consumables applied. Review the totals, then upload.",
            );
            return true;
        } finally {
            setApplyingConsumables(false);
        }
    }

    async function uploadSelected() {
        if (!selected || !uploadPreview || uploadPreview.unmatchedEntries.length > 0 || actionBusy) return;
        if (selected.garmothUploadStatus === "unknown") return;
        const repeatUpload = selected.garmothUploadStatus === "success";
        if (repeatUpload && !window.confirm("Upload this session again? This creates another session on Garmoth."))
            return;
        historyRequestId.current += 1;
        setUploading(true);
        setUploadMessage("");
        setUploadError("");
        try {
            const result = await uploadGarmothSession({ ...uploadPreview.input, repeatUpload });
            setRecords(
                (current) =>
                    current?.map((record) =>
                        record.session.id === selected.session.id
                            ? { ...record, garmothUploadStatus: result.status }
                            : record,
                    ) ?? null,
            );
            if (result.status === "success") setUploadMessage(result.message);
            else setUploadError(result.message);
            void loadHistory(false);
        } catch (uploadFailure) {
            setUploadError(String(uploadFailure));
            await loadHistory();
        } finally {
            setUploading(false);
        }
    }

    async function deleteRecord(record: FinishedSessionRecord) {
        if (deletingId !== null) return;
        const name = spotName(record.session.grindSpotId);
        const confirmed = window.confirm(
            `Delete the ${name} session from ${formatTimestamp(record.finishedAt)}? This permanently removes the session and all of its entries.`,
        );
        if (!confirmed) return;

        historyRequestId.current += 1;
        const deletedIndex = pageRecords.findIndex((candidate) => candidate.session.id === record.session.id);
        const nextFocusId =
            pageRecords[deletedIndex + 1]?.session.id ?? pageRecords[deletedIndex - 1]?.session.id ?? null;
        const deletingSelected = selected?.session.id === record.session.id;
        setDeletingId(record.session.id);
        setDeleteError("");
        setDeleteMessage("");
        try {
            await deleteFinishedSession(record.session.id);
            setRecords((current) => current?.filter((candidate) => candidate.session.id !== record.session.id) ?? null);
            if (deletingSelected) {
                setSelectedId(nextFocusId);
                setReopenError("");
                setUploadMessage("");
                setUploadError("");
            }
            setRestoreFocus({ sessionId: nextFocusId, target: deletingSelected ? "select" : "delete" });
            setDeleteMessage(`Deleted the ${name} session from ${formatTimestamp(record.finishedAt)}.`);
            const refreshError = await loadHistory(false);
            if (refreshError) {
                setDeleteError(`Session was deleted, but history could not be refreshed: ${refreshError}`);
            }
        } catch (deleteFailure) {
            setDeleteError(`Could not delete session: ${String(deleteFailure)}`);
            setRestoreFocus({ sessionId: record.session.id, target: "delete" });
            void loadHistory(false);
        } finally {
            setDeletingId((current) => (current === record.session.id ? null : current));
        }
    }

    return (
        <>
            <header className="topbar">
                <h1>Session history</h1>
                <div className={styles.HistoryActions}>
                    <button
                        ref={filterButton}
                        className="button"
                        type="button"
                        aria-label="Filters"
                        aria-haspopup="dialog"
                        disabled={!databaseLoaded || actionBusy}
                        onClick={() => {
                            filterDialog.current?.showModal();
                            regionInput.current?.focus();
                        }}
                    >
                        Filters · {region.toUpperCase()}
                        {activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                    </button>
                    <button
                        ref={reloadButton}
                        className="button subtle"
                        type="button"
                        disabled={!databaseLoaded || actionBusy}
                        onClick={() => void loadHistory()}
                    >
                        Reload
                    </button>
                </div>
            </header>
            <dialog
                ref={filterDialog}
                className={`${dialogStyles.ToolDialog} ${styles.FilterDialog}`}
                aria-labelledby="history-filters-title"
                onClose={() => filterButton.current?.focus()}
            >
                <header className={dialogStyles.DialogHeading}>
                    <h2 id="history-filters-title">Filters</h2>
                    <button
                        className="button subtle"
                        type="button"
                        aria-label="Close filters"
                        onClick={() => filterDialog.current?.close()}
                    >
                        Close <kbd>Esc</kbd>
                    </button>
                </header>
                <div className={styles.FilterFields}>
                    <label>
                        Region
                        <select
                            ref={regionInput}
                            aria-label="Recorded region"
                            value={region}
                            disabled={!databaseLoaded || actionBusy}
                            onChange={(event) => {
                                resetPage();
                                setRegion(event.target.value as "eu" | "na");
                            }}
                        >
                            <option value="eu">EU</option>
                            <option value="na">NA</option>
                        </select>
                    </label>
                    <label>
                        Grind spot
                        <select
                            aria-label="Grind spot"
                            value={grindSpotFilter}
                            disabled={!databaseLoaded || actionBusy}
                            onChange={(event) => selectSpot(event.target.value)}
                        >
                            <option value="all">All grind spots</option>
                            {grindSpotFilter !== "all" && !grindSpots.some((spot) => spot.id === grindSpotFilter) && (
                                <option value={grindSpotFilter}>{grindSpotFilter}</option>
                            )}
                            {history?.spotSummaries
                                .filter(
                                    (spot) =>
                                        spot.grindSpotId !== grindSpotFilter &&
                                        !grindSpots.some((known) => known.id === spot.grindSpotId),
                                )
                                .map((spot) => (
                                    <option key={spot.grindSpotId} value={spot.grindSpotId}>
                                        {spot.grindSpotId}
                                    </option>
                                ))}
                            {grindSpots.map((spot) => (
                                <option key={spot.id} value={spot.id}>
                                    {spot.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Completed from
                        <input
                            type="date"
                            min="1970-01-01"
                            value={fromDate}
                            disabled={!databaseLoaded || actionBusy}
                            onChange={(event) => {
                                resetPage();
                                setFromDate(event.target.value);
                            }}
                        />
                    </label>
                    <label>
                        Completed through
                        <input
                            type="date"
                            min="1970-01-01"
                            id="history-completed-through"
                            value={toDate}
                            disabled={!databaseLoaded || actionBusy}
                            onChange={(event) => {
                                resetPage();
                                setToDate(event.target.value);
                            }}
                        />
                    </label>
                </div>
                {error && (
                    <p className={styles.FilterError} role="alert">
                        {error}
                    </p>
                )}
                <div className={styles.FilterFooter}>
                    <button
                        className="button subtle"
                        type="button"
                        disabled={!databaseLoaded || actionBusy}
                        onClick={() => {
                            resetPage();
                            setRegion(null);
                            setFromDate("");
                            setToDate("");
                            setGrindSpotFilter("all");
                        }}
                    >
                        Clear filters
                    </button>
                </div>
            </dialog>

            {history && !error && historyTotals.sessionCount > 0 && (
                <section className={styles.Overview} aria-label="Filtered history summary">
                    <div>
                        <span>
                            Recorded net · {historyTotals.sessionCount}{" "}
                            {historyTotals.sessionCount === 1 ? "session" : "sessions"}
                        </span>
                        <strong>
                            {formatSilver(historyTotals.net, true)}
                            <small> silver</small>
                        </strong>
                    </div>
                    <div>
                        <span>Time tracked</span>
                        <strong>{formatDuration(trackedMs)}</strong>
                    </div>
                    <div>
                        <span>Net / hour</span>
                        <strong>
                            {historyRate === null ? "—" : formatSilver(historyRate, true)}
                            <small> silver</small>
                        </strong>
                        {historyTotals.zeroDurationCount > 0 && (
                            <span className={styles.TimedCount}>
                                {historyTotals.sessionCount - historyTotals.zeroDurationCount} timed sessions
                            </span>
                        )}
                    </div>
                </section>
            )}
            {history && !error && comparisonSpots.length > 0 && (
                <section className={styles.Comparisons} aria-label="Grind spot comparisons">
                    <h2>Grind spot comparisons</h2>
                    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access. */}
                    <section className={styles.ComparisonScroll} aria-label="Spot earnings table" tabIndex={0}>
                        <table>
                            <thead>
                                <tr>
                                    <th scope="col">Grind spot</th>
                                    <th scope="col">Net / hour</th>
                                    <th scope="col">Sessions</th>
                                    <th scope="col">Time tracked</th>
                                    <th scope="col">Recorded net</th>
                                </tr>
                            </thead>
                            <tbody>
                                {comparisonSpots.map((spot) => {
                                    const rate = netPerHour(spot);
                                    return (
                                        <tr key={spot.grindSpotId}>
                                            <th scope="row">
                                                <button
                                                    type="button"
                                                    className="button subtle"
                                                    disabled={actionBusy || loading}
                                                    onClick={() => selectSpot(spot.grindSpotId)}
                                                >
                                                    {spotName(spot.grindSpotId)}
                                                </button>
                                            </th>
                                            <td>{rate === null ? "—" : `${formatSilver(rate, true)}/h`}</td>
                                            <td>
                                                {spot.sessionCount}
                                                {spot.zeroDurationCount > 0 && (
                                                    <small>{spot.sessionCount - spot.zeroDurationCount} timed</small>
                                                )}
                                            </td>
                                            <td>{formatDuration(spot.elapsedMs)}</td>
                                            <td>{formatSilver(spot.net, true)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </section>
                </section>
            )}
            {deleteMessage && (
                <p className={styles.DeleteStatus} role="status">
                    {deleteMessage}
                </p>
            )}
            {deleteError && (
                <p className={styles.DeleteError} role="alert">
                    {deleteError}
                </p>
            )}

            {!databaseLoaded || records === null ? (
                <section className={`panel ${styles.HistoryMessage}`}>
                    <strong role="status">Reading completed sessions...</strong>
                </section>
            ) : error ? (
                <section className={`panel ${styles.HistoryMessage} ${styles.ErrorMessage}`}>
                    <strong>Could not load session history</strong>
                    <p role="alert">{error}</p>
                </section>
            ) : records.length === 0 ? (
                <section className={`panel empty-state ${styles.HistoryMessage}`}>
                    <div className="empty-glyph">0</div>
                    <strong>No sessions match these filters</strong>
                    <p>Clear the filters or finish a session in this region.</p>
                </section>
            ) : (
                <div className={styles.HistoryGrid}>
                    <section className="panel">
                        <div className="panel-heading">
                            <div>
                                <h2 aria-live="polite">
                                    {(history?.offset ?? 0) + 1}–{(history?.offset ?? 0) + pageRecords.length} of{" "}
                                    {history?.totalCount ?? pageRecords.length} sessions
                                </h2>
                            </div>
                        </div>
                        <nav className={styles.Pagination} aria-label="History pages">
                            <button
                                className="button subtle"
                                type="button"
                                ref={previousButton}
                                disabled={actionBusy || loading || !history || history.offset === 0}
                                onClick={() => changePage(Math.max(0, (history?.offset ?? 0) - 20))}
                            >
                                Previous
                            </button>
                            <button
                                className="button subtle"
                                type="button"
                                disabled={
                                    actionBusy || loading || !history || history.offset + 20 >= history.totalCount
                                }
                                ref={nextButton}
                                onClick={() => changePage((history?.offset ?? 0) + 20)}
                            >
                                Next
                            </button>
                        </nav>
                        <div className={styles.HistoryList}>
                            {pageRecords.map((record) => {
                                const totals = calculateTotals(record.session.entries, record.session.elapsedMs);
                                const selectedRecord = record.session.id === selected?.session.id;
                                return (
                                    <div className={styles.HistoryRow} key={record.session.id}>
                                        <button
                                            className={`${styles.HistorySelect} ${selectedRecord ? styles.Selected : ""}`}
                                            type="button"
                                            aria-pressed={selectedRecord}
                                            disabled={actionBusy}
                                            ref={(element) => {
                                                if (element)
                                                    historySelectButtons.current.set(record.session.id, element);
                                                else historySelectButtons.current.delete(record.session.id);
                                            }}
                                            onClick={() => {
                                                setSelectedId(record.session.id);
                                                setReopenError("");
                                                setDeleteError("");
                                                setUploadMessage("");
                                                setUploadError("");
                                            }}
                                        >
                                            <span>
                                                <strong>{spotName(record.session.grindSpotId)}</strong>
                                                <small>
                                                    {formatTimestamp(record.finishedAt)} ·{" "}
                                                    {record.session.region.toUpperCase()} ·{" "}
                                                    {formatDuration(record.session.elapsedMs)}
                                                </small>
                                            </span>
                                            <span className={styles.HistoryValue}>
                                                <strong>
                                                    {record.session.elapsedMs > 0
                                                        ? `${formatSilver(totals.netPerHour, true)}/h`
                                                        : "—"}
                                                </strong>
                                                <small>{formatSilver(totals.net, true)} net</small>
                                            </span>
                                        </button>
                                        <button
                                            className={styles.DeleteButton}
                                            type="button"
                                            disabled={actionBusy}
                                            aria-label={`Delete ${spotName(record.session.grindSpotId)} session from ${formatTimestamp(record.finishedAt)}`}
                                            ref={(element) => {
                                                if (element)
                                                    historyDeleteButtons.current.set(record.session.id, element);
                                                else historyDeleteButtons.current.delete(record.session.id);
                                            }}
                                            onClick={() => void deleteRecord(record)}
                                        >
                                            {deletingId === record.session.id ? "Deleting..." : "Delete"}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </section>

                    {selected && selectedTotals && (
                        <section className="panel">
                            <div className="panel-heading">
                                <div>
                                    <p className="eyebrow">{formatTimestamp(selected.finishedAt)} · Completed</p>
                                    <h2>{spotName(selected.session.grindSpotId)}</h2>
                                </div>
                                <div className={styles.DetailActions}>
                                    <span>{selected.session.region.toUpperCase()}</span>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={
                                            !databaseLoaded ||
                                            databaseStatus === "saving" ||
                                            actionBusy ||
                                            selected.garmothUploadStatus !== null
                                        }
                                        onClick={reopenSelected}
                                    >
                                        {reopening ? "Reopening..." : "Reopen"}
                                    </button>
                                </div>
                            </div>
                            {consumableMessage && <p role="status">{consumableMessage}</p>}
                            {reopenError && (
                                <p className={styles.ActionError} role="alert">
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
                                    <strong>
                                        {selected.session.elapsedMs > 0
                                            ? formatSilver(selectedTotals.netPerHour, true)
                                            : "—"}
                                    </strong>
                                </div>
                            </div>
                            {selected.session.entries.length === 0 ? (
                                <div className={`empty-state ${styles.HistoryEntriesEmpty}`}>
                                    <strong>No entries recorded</strong>
                                </div>
                            ) : (
                                <div className={styles.HistoryEntries}>
                                    {selected.session.entries.map((entry) => {
                                        const icon = getDropIcon(selected.session.grindSpotId, entry.name);
                                        return (
                                            <div className={styles.HistoryEntry} key={entry.id}>
                                                {icon ? (
                                                    <img
                                                        className={styles.ItemIcon}
                                                        src={icon}
                                                        alt=""
                                                        width={30}
                                                        height={30}
                                                    />
                                                ) : (
                                                    <div className={`item-swatch ${entry.valuation}`}>
                                                        {entry.valuation === "expense" ? "−" : "+"}
                                                    </div>
                                                )}
                                                <span>
                                                    <strong>{entry.name}</strong>
                                                    <small>
                                                        x{formatSilver(entry.quantity)} ·{" "}
                                                        {formatSilver(entry.unitPrice)} each
                                                    </small>
                                                </span>
                                                <strong className={entry.valuation === "expense" ? "negative" : ""}>
                                                    {entry.valuation === "expense" ? "-" : ""}
                                                    {formatSilver(entry.quantity * entry.unitPrice, true)}
                                                </strong>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            <div className={styles.GarmothUpload}>
                                <div className={styles.UploadHeading}>
                                    <div>
                                        <span>Garmoth upload</span>
                                        <strong>
                                            {selected.garmothUploadStatus === "success"
                                                ? "Uploaded"
                                                : selected.garmothUploadStatus === "unknown"
                                                  ? "Confirmation unknown"
                                                  : !garmothSettingsLoaded
                                                    ? "Loading connection…"
                                                    : !uploadCharacter
                                                      ? "Connect a character to share"
                                                      : "Ready for review"}
                                        </strong>
                                    </div>
                                    {selected.garmothUploadStatus === "unknown" ? null : !garmothSettingsLoaded ? (
                                        <button className="button" type="button" disabled>
                                            Loading settings...
                                        </button>
                                    ) : !uploadCharacter ? (
                                        <button
                                            className="button subtle"
                                            type="button"
                                            disabled={actionBusy}
                                            onClick={onOpenSettings}
                                        >
                                            Open Settings
                                        </button>
                                    ) : uploadPreview?.consumableCount === 0 ? (
                                        <ConsumablePresetPicker
                                            key={selected.session.id}
                                            session={selected.session}
                                            disabled={
                                                !databaseLoaded ||
                                                databaseStatus === "saving" ||
                                                actionBusy ||
                                                uploadPreview.unmatchedEntries.length > 0
                                            }
                                            onApply={applyConsumables}
                                            beforeUpload={{
                                                repeat: selected.garmothUploadStatus === "success",
                                                onSkip: () => void uploadSelected(),
                                            }}
                                        />
                                    ) : (
                                        <button
                                            className="button primary-button"
                                            type="button"
                                            disabled={
                                                actionBusy ||
                                                !uploadPreview ||
                                                uploadPreview.unmatchedEntries.length > 0
                                            }
                                            onClick={uploadSelected}
                                        >
                                            {uploading
                                                ? "Uploading..."
                                                : selected.garmothUploadStatus === "success"
                                                  ? "Upload again"
                                                  : "Upload to Garmoth"}
                                        </button>
                                    )}
                                </div>
                                {uploadPreview && (
                                    <div className={styles.UploadPreview}>
                                        <span>{uploadPreview.input.minutes} minutes</span>
                                        <span>{formatSilver(uploadPreview.input.total, true)} total</span>
                                        <span>{formatSilver(uploadPreview.input.hourly, true)}/h</span>
                                        <span>{uploadPreview.mappedDropCount} recorded drops</span>
                                        <span>{uploadPreview.consumableCount} consumables</span>
                                        {uploadCharacter && <span>{uploadCharacter.name}</span>}
                                    </div>
                                )}
                                {selected.garmothUploadStatus === null && garmothSettingsLoaded && !uploadCharacter && (
                                    <p>Save an API key and upload character in Settings before uploading.</p>
                                )}
                                {selected.garmothUploadStatus === null && settingsError && (
                                    <p className={styles.UploadError} role="alert">
                                        Could not read Garmoth settings: {settingsError}
                                    </p>
                                )}
                                {uploadPreview?.unmatchedEntries.length ? (
                                    <p className={styles.UploadError} role="alert">
                                        These revenue entries have no Garmoth drop mapping:{" "}
                                        {uploadPreview.unmatchedEntries.join(", ")}. Reopen the session and remove or
                                        rename them before uploading.
                                    </p>
                                ) : null}
                                {uploadPreviewError && (
                                    <p className={styles.UploadError} role="alert">
                                        {uploadPreviewError}
                                    </p>
                                )}
                                {selected.garmothUploadStatus === "unknown" && !uploadError && (
                                    <p className={styles.UploadError} role="alert">
                                        The upload outcome is unknown. Check your Garmoth grind tracker; automatic and
                                        manual retries are blocked to avoid a duplicate.
                                    </p>
                                )}
                                {selected.garmothUploadStatus === "success" && (
                                    <p className={styles.UploadSuccess}>This session is recorded as uploaded.</p>
                                )}
                                {(uploadMessage || uploadError) && (
                                    <p
                                        className={uploadError ? styles.UploadError : styles.UploadSuccess}
                                        role={uploadError ? "alert" : "status"}
                                    >
                                        {uploadError || uploadMessage}
                                    </p>
                                )}
                            </div>
                        </section>
                    )}
                </div>
            )}
        </>
    );
}
