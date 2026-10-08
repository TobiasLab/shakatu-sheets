import { useEffect, useRef, useState } from "react";
import {
    deleteFinishedSession,
    type FinishedSessionRecord,
    type GarmothSettings,
    type HistoryResult,
    listFinishedSessions,
    loadGarmothSettings,
    loadSessionTrend,
    resolveGarmothUpload,
} from "../../api/tauri";
import { EmptyState, Feedback } from "../../components/Feedback/Feedback";
import { SelectionButton } from "../../components/SelectionButton/SelectionButton";
import { grindSpotName, grindSpots } from "../../data/grindSpots";
import { historyDateBoundary, netPerHour, rankSpots, summarizeHistory } from "../../domain/history";
import { calculateTotals, type SessionState } from "../../domain/session";
import { hasRecordedTrend, type TrendSample } from "../../domain/trend";
import { formatDuration, formatSilver, formatTimestamp } from "../../format";
import { buildGarmothUpload, type GarmothUploadPreview, getGarmothUploadNotice } from "../../garmoth";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import { SessionTrend } from "../LiveSession/SessionTrend";
import { GarmothUploadDialog } from "./GarmothUploadDialog";
import styles from "./History.module.css";
import { RecordedEntries } from "./RecordedEntries";
import { SpotComparisons } from "./SpotComparisons";

function localDateOffset(days: number) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
    // null follows the live session's region; "all" lists every region together.
    const [selectedRegion, setRegion] = useState<"eu" | "na" | "all" | null>(null);
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
    const [uploadReview, setUploadReview] = useState<FinishedSessionRecord | null>(null);
    const uploadButton = useRef<HTMLButtonElement>(null);
    const [uploading, setUploading] = useState(false);
    const [resolvingUpload, setResolvingUpload] = useState(false);
    const [uploadMessage, setUploadMessage] = useState("");
    const [uploadError, setUploadError] = useState("");
    const [settingsError, setSettingsError] = useState("");
    const [garmothSettingsLoaded, setGarmothSettingsLoaded] = useState(false);
    const [trend, setTrend] = useState<{ sessionId: string; samples: TrendSample[] } | null>(null);
    const reloadButton = useRef<HTMLButtonElement>(null);
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
                region: region === "all" ? null : region,
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

    // Page loads wait for an in-flight save so a just-finished session is listed; autosaves leave a shown page alone.
    const waitingForSave = databaseStatus === "saving" && records === null;
    useEffect(() => {
        if (databaseLoaded && !waitingForSave) void loadHistory();
        return () => {
            historyRequestId.current += 1;
        };
    }, [databaseLoaded, waitingForSave, region, fromDate, toDate, grindSpotFilter, offset]);

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
    const selectedSessionId = selected?.session.id;
    const selectedSamples = trend !== null && trend.sessionId === selectedSessionId ? trend.samples : [];
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
    const actionBusy = uploading || resolvingUpload || reopening || deletingId !== null;
    const dateError = fromDate && toDate && fromDate > toDate ? "The From date must be on or before the To date." : "";
    function clearFilters() {
        resetPage();
        setRegion(null);
        setFromDate("");
        setToDate("");
        setGrindSpotFilter("all");
    }
    const hasFilters = Boolean(fromDate || toDate) || grindSpotFilter !== "all" || region !== initialRegion;
    const recentRange =
        !toDate && fromDate === localDateOffset(-6) ? 7 : !toDate && fromDate === localDateOffset(-29) ? 30 : null;

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

    // Finished sessions are immutable, so samples load once per selection; a slower earlier request is ignored.
    useEffect(() => {
        if (!selectedSessionId) return;
        let current = true;
        loadSessionTrend(selectedSessionId)
            .then((samples) => {
                if (current) setTrend({ sessionId: selectedSessionId, samples });
            })
            .catch(() => {
                if (current) setTrend({ sessionId: selectedSessionId, samples: [] });
            });
        return () => {
            current = false;
        };
    }, [selectedSessionId]);

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

    async function deleteRecord(record: FinishedSessionRecord) {
        if (deletingId !== null) return;
        const name = grindSpotName(record.session.grindSpotId);
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

    async function resolveUnknownUpload(sessionId: string, uploaded: boolean) {
        setResolvingUpload(true);
        setUploadMessage("");
        setUploadError("");
        try {
            await resolveGarmothUpload(sessionId, uploaded);
            setRecords(
                (current) =>
                    current?.map((record) =>
                        record.session.id === sessionId
                            ? { ...record, garmothUploadStatus: uploaded ? "success" : null }
                            : record,
                    ) ?? null,
            );
            setUploadMessage(
                uploaded ? "Recorded as uploaded to Garmoth." : "Recorded as not on Garmoth. You can upload it again.",
            );
            requestAnimationFrame(() => (uploadButton.current ?? reloadButton.current)?.focus());
            void loadHistory(false);
        } catch (failure) {
            setUploadError(`Could not record the Garmoth check: ${String(failure)}`);
        } finally {
            setResolvingUpload(false);
        }
    }

    function uploadStatusLabel() {
        if (selected?.garmothUploadStatus === "success") return "Uploaded";
        if (selected?.garmothUploadStatus === "unknown") return "Confirmation unknown";
        if (!garmothSettingsLoaded) return "Loading connection…";
        if (!uploadCharacter) return "Connect a character to share";
        if (uploadPreviewError) return "Upload unavailable";
        return "Ready for review";
    }

    return (
        <>
            <header className="topbar">
                <h1>Session history</h1>
                <button
                    ref={reloadButton}
                    className="button subtle"
                    type="button"
                    disabled={!databaseLoaded || actionBusy}
                    onClick={() => void loadHistory()}
                >
                    Reload
                </button>
            </header>
            <fieldset className={styles.FilterBar} aria-label="Filters" disabled={!databaseLoaded || actionBusy}>
                <fieldset className="segmented" aria-label="Recorded region">
                    {(["all", "eu", "na"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={region === value}
                            onClick={() => {
                                resetPage();
                                setRegion(value);
                            }}
                        >
                            {value === "all" ? "All" : value.toUpperCase()}
                        </button>
                    ))}
                </fieldset>
                <select
                    className={styles.SpotFilter}
                    aria-label="Grind spot"
                    value={grindSpotFilter}
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
                <div className={styles.DateRange}>
                    <input
                        type="date"
                        aria-label="Completed from"
                        aria-invalid={Boolean(dateError)}
                        aria-describedby={dateError ? "history-date-error" : undefined}
                        min="1970-01-01"
                        value={fromDate}
                        onChange={(event) => {
                            resetPage();
                            setFromDate(event.target.value);
                        }}
                    />
                    <span aria-hidden="true">–</span>
                    <input
                        type="date"
                        aria-label="Completed through"
                        aria-invalid={Boolean(dateError)}
                        aria-describedby={dateError ? "history-date-error" : undefined}
                        min="1970-01-01"
                        id="history-completed-through"
                        value={toDate}
                        onChange={(event) => {
                            resetPage();
                            setToDate(event.target.value);
                        }}
                    />
                </div>
                <fieldset className="segmented" aria-label="Recent sessions">
                    {([7, 30] as const).map((days) => (
                        <button
                            key={days}
                            type="button"
                            aria-pressed={recentRange === days}
                            onClick={() => {
                                resetPage();
                                setFromDate(localDateOffset(1 - days));
                                setToDate("");
                            }}
                        >
                            {days} days
                        </button>
                    ))}
                </fieldset>
                {hasFilters && (
                    <button className="button subtle" type="button" onClick={clearFilters}>
                        Clear filters
                    </button>
                )}
            </fieldset>
            {history && !error && historyTotals.sessionCount > 0 && (
                <section className={styles.Overview} aria-label="Filtered history summary">
                    <div>
                        <span>
                            Recorded net · {historyTotals.sessionCount}{" "}
                            {historyTotals.sessionCount === 1 ? "session" : "sessions"}
                        </span>
                        <strong>{formatSilver(historyTotals.net, true)}</strong>
                    </div>
                    <div>
                        <span>Time tracked</span>
                        <strong>{formatDuration(trackedMs)}</strong>
                    </div>
                    <div>
                        <span>Net / hour</span>
                        <strong>{historyRate === null ? "—" : formatSilver(historyRate, true)}</strong>
                        {historyTotals.zeroDurationCount > 0 && (
                            <span className={styles.TimedCount}>
                                {historyTotals.sessionCount - historyTotals.zeroDurationCount} timed sessions
                            </span>
                        )}
                    </div>
                </section>
            )}
            {history && !error && comparisonSpots.length > 0 && (
                <SpotComparisons
                    spots={comparisonSpots}
                    selectedSpotId={grindSpotFilter}
                    disabled={actionBusy || loading}
                    onSelect={selectSpot}
                />
            )}
            {deleteMessage && <Feedback tone="success">{deleteMessage}</Feedback>}
            {deleteError && <Feedback tone="error">{deleteError}</Feedback>}

            {!databaseLoaded || records === null ? (
                <Feedback>Reading completed sessions…</Feedback>
            ) : error ? (
                <Feedback
                    id={dateError ? "history-date-error" : undefined}
                    tone="error"
                    action={
                        <button
                            className="button"
                            type="button"
                            disabled={loading || actionBusy}
                            onClick={() => (dateError ? clearFilters() : void loadHistory())}
                        >
                            {dateError ? "Clear filters" : "Retry history"}
                        </button>
                    }
                >
                    {dateError || `Could not load session history. ${error}`}
                </Feedback>
            ) : records.length === 0 ? (
                <EmptyState
                    title={hasFilters ? "No sessions match these filters" : "No completed sessions yet"}
                    action={
                        hasFilters ? (
                            <button className="button subtle" type="button" onClick={clearFilters}>
                                Clear filters
                            </button>
                        ) : undefined
                    }
                >
                    {hasFilters ? undefined : `Finish a session in ${region.toUpperCase()} to see it here.`}
                </EmptyState>
            ) : (
                <div className={styles.HistoryGrid}>
                    <section className={`panel ${styles.ListPanel}`}>
                        <div className="panel-heading">
                            <div>
                                <h2 aria-live="polite">
                                    {(history?.offset ?? 0) + 1}–{(history?.offset ?? 0) + pageRecords.length} of{" "}
                                    {history?.totalCount ?? pageRecords.length} sessions
                                </h2>
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
                        </div>
                        <div className={styles.HistoryList}>
                            {pageRecords.map((record) => {
                                const totals = calculateTotals(record.session.entries, record.session.elapsedMs);
                                const selectedRecord = record.session.id === selected?.session.id;
                                return (
                                    <div className={styles.HistoryRow} key={record.session.id}>
                                        <SelectionButton
                                            className={`${styles.HistorySelect} ${selectedRecord ? styles.Selected : ""}`}
                                            selected={selectedRecord}
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
                                                <strong>{grindSpotName(record.session.grindSpotId)}</strong>
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
                                        </SelectionButton>
                                        <button
                                            className={styles.DeleteButton}
                                            type="button"
                                            disabled={actionBusy}
                                            aria-label={`Delete ${grindSpotName(record.session.grindSpotId)} session from ${formatTimestamp(record.finishedAt)}`}
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
                        <section className={`panel ${styles.DetailPanel}`}>
                            <div className="panel-heading">
                                <div>
                                    <p className="eyebrow">{formatTimestamp(selected.finishedAt)} · Completed</p>
                                    <h2>{grindSpotName(selected.session.grindSpotId)}</h2>
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
                            {reopenError && <Feedback tone="error">{reopenError}</Feedback>}
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
                                {hasRecordedTrend(selectedSamples, selected.session.elapsedMs) && (
                                    <SessionTrend
                                        samples={selectedSamples}
                                        elapsedMs={selected.session.elapsedMs}
                                        net={selectedTotals.net}
                                    />
                                )}
                            </div>
                            <RecordedEntries session={selected.session} />
                            <div className={styles.GarmothUpload}>
                                <div className={styles.UploadHeading}>
                                    <div>
                                        <span>Garmoth upload</span>
                                        <strong>{uploadStatusLabel()}</strong>
                                    </div>
                                    {selected.garmothUploadStatus === "unknown" ? (
                                        <div className={styles.UploadActions}>
                                            <button
                                                className="button"
                                                type="button"
                                                disabled={actionBusy}
                                                onClick={() => void resolveUnknownUpload(selected.session.id, true)}
                                            >
                                                It's on Garmoth
                                            </button>
                                            <button
                                                className="button subtle"
                                                type="button"
                                                disabled={actionBusy}
                                                onClick={() => void resolveUnknownUpload(selected.session.id, false)}
                                            >
                                                It's not there
                                            </button>
                                        </div>
                                    ) : !garmothSettingsLoaded ? (
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
                                    ) : (
                                        <button
                                            className="button primary-button"
                                            type="button"
                                            disabled={actionBusy || !uploadPreview}
                                            ref={uploadButton}
                                            onClick={() => {
                                                setUploadError("");
                                                setUploadMessage("");
                                                setUploadReview(selected);
                                            }}
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
                                {uploadPreview && uploadPreview.omittedEntries.length > 0 && (
                                    <Feedback>{getGarmothUploadNotice(uploadPreview)}</Feedback>
                                )}
                                {uploadPreviewError && <Feedback tone="error">{uploadPreviewError}</Feedback>}
                                {selected.garmothUploadStatus === "unknown" && !uploadError && (
                                    <p className={styles.UploadError} role="alert">
                                        Garmoth did not confirm this upload. Check your Garmoth grind tracker, then
                                        record whether the session is there. Uploading again stays blocked until then to
                                        avoid a duplicate.
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
            {uploadReview && uploadCharacter && (
                <GarmothUploadDialog
                    record={uploadReview}
                    characterName={uploadCharacter.name}
                    initialBuffIds={garmothSettings?.buffIds ?? []}
                    // Submitting saves the selection as the default for the next review.
                    onBuffsSubmitted={(buffIds) => setGarmothSettings((current) => current && { ...current, buffIds })}
                    onBusy={setUploading}
                    onClose={() => {
                        setUploadReview(null);
                        requestAnimationFrame(() => (uploadButton.current ?? reloadButton.current)?.focus());
                    }}
                    onResult={(result) => {
                        setRecords(
                            (current) =>
                                current?.map((record) =>
                                    record.session.id === uploadReview.session.id
                                        ? {
                                              ...record,
                                              session: result.savedSession ?? record.session,
                                              garmothUploadStatus:
                                                  result.status === "failed"
                                                      ? record.garmothUploadStatus
                                                      : result.status,
                                          }
                                        : record,
                                ) ?? null,
                        );
                        if (result.savedSession) onSessionCorrected(result.savedSession);
                        if (result.status === "success") setUploadMessage(result.message);
                        else setUploadError(result.message);
                        void loadHistory(false);
                    }}
                />
            )}
        </>
    );
}
