import { useEffect, useRef, useState } from "react";
import {
    deleteFinishedSession,
    type FinishedSessionRecord,
    type GarmothSettings,
    listFinishedSessions,
    loadGarmothSettings,
    uploadGarmothSession,
} from "../../api/tauri";
import { getGrindSpot, grindSpots } from "../../data/grindSpots";
import { calculateTotals } from "../../domain/session";
import { formatDuration, formatSilver, formatTimestamp } from "../../format";
import { buildGarmothUpload, type GarmothUploadPreview } from "../../garmoth";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import styles from "./History.module.css";

export function HistoryView({
    databaseLoaded,
    databaseStatus,
    onReopen,
    onOpenSettings,
}: {
    databaseLoaded: boolean;
    databaseStatus: DatabaseStatus;
    onReopen: (id: string) => Promise<void>;
    onOpenSettings: () => void;
}) {
    const [records, setRecords] = useState<FinishedSessionRecord[] | null>(null);
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
    const [uploading, setUploading] = useState(false);
    const [uploadMessage, setUploadMessage] = useState("");
    const [uploadError, setUploadError] = useState("");
    const [settingsError, setSettingsError] = useState("");
    const [garmothSettingsLoaded, setGarmothSettingsLoaded] = useState(false);
    const reloadButton = useRef<HTMLButtonElement>(null);
    const historySelectButtons = useRef(new Map<string, HTMLButtonElement>());
    const historyDeleteButtons = useRef(new Map<string, HTMLButtonElement>());
    const historyRequestId = useRef(0);

    async function loadHistory(showLoading = true) {
        const requestId = ++historyRequestId.current;
        if (showLoading) {
            setRecords(null);
            setDeleteError("");
            setDeleteMessage("");
        }
        setError("");
        try {
            const finished = await listFinishedSessions();
            if (requestId !== historyRequestId.current) return "";
            setRecords(finished);
            setSelectedId((current) =>
                finished.some((record) => record.session.id === current) ? current : (finished[0]?.session.id ?? null),
            );
            return "";
        } catch (loadError) {
            if (requestId !== historyRequestId.current) return "";
            const detail = String(loadError);
            if (showLoading) {
                setRecords([]);
                setError(detail);
            }
            return detail;
        }
    }

    useEffect(() => {
        if (databaseLoaded && databaseStatus !== "saving") loadHistory();
    }, [databaseLoaded, databaseStatus]);

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

    const filteredRecords =
        records?.filter((record) => grindSpotFilter === "all" || record.session.grindSpotId === grindSpotFilter) ?? [];
    const selected = filteredRecords.find((record) => record.session.id === selectedId) ?? filteredRecords[0];
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
    const actionBusy = uploading || reopening || deletingId !== null;

    useEffect(() => {
        if (!restoreFocus || deletingId !== null) return;
        const target = restoreFocus.sessionId
            ? ((restoreFocus.target === "select" ? historySelectButtons : historyDeleteButtons).current.get(
                  restoreFocus.sessionId,
              ) ?? reloadButton.current)
            : reloadButton.current;
        if (!target) return;
        target.focus();
        setRestoreFocus(null);
    }, [deletingId, restoreFocus, filteredRecords]);

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

    async function uploadSelected() {
        if (!selected || !uploadPreview || uploadPreview.unmatchedEntries.length > 0) return;
        historyRequestId.current += 1;
        setUploading(true);
        setUploadMessage("");
        setUploadError("");
        try {
            const result = await uploadGarmothSession(uploadPreview.input);
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
        const spotName = getGrindSpot(record.session.grindSpotId).name;
        const confirmed = window.confirm(
            `Delete the ${spotName} session from ${formatTimestamp(record.finishedAt)}? This permanently removes the session and all of its entries.`,
        );
        if (!confirmed) return;

        historyRequestId.current += 1;
        const deletedIndex = filteredRecords.findIndex((candidate) => candidate.session.id === record.session.id);
        const nextFocusId =
            filteredRecords[deletedIndex + 1]?.session.id ?? filteredRecords[deletedIndex - 1]?.session.id ?? null;
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
            setDeleteMessage(`Deleted the ${spotName} session from ${formatTimestamp(record.finishedAt)}.`);
            setDeletingId((current) => (current === record.session.id ? null : current));
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
                <div>
                    <p className="eyebrow">Completed sessions</p>
                    <h1>Session history</h1>
                </div>
                <div className={styles.HistoryActions}>
                    <label>
                        Grind spot
                        <select
                            value={grindSpotFilter}
                            disabled={!databaseLoaded || records === null || records.length === 0 || actionBusy}
                            onChange={(event) => {
                                setGrindSpotFilter(event.target.value);
                                setSelectedId(null);
                                setReopenError("");
                                setDeleteError("");
                                setUploadMessage("");
                                setUploadError("");
                            }}
                        >
                            <option value="all">All grind spots</option>
                            {grindSpots.map((spot) => (
                                <option key={spot.id} value={spot.id}>
                                    {spot.name}
                                </option>
                            ))}
                        </select>
                    </label>
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
            ) : filteredRecords.length === 0 ? (
                <section className={`panel empty-state ${styles.HistoryMessage}`}>
                    <div className="empty-glyph">0</div>
                    <strong>No {getGrindSpot(grindSpotFilter).name} sessions</strong>
                    <p>Choose another grind spot or finish a new session.</p>
                </section>
            ) : (
                <div className={styles.HistoryGrid}>
                    <section className="panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Recent ledger</p>
                                <h2>
                                    {filteredRecords.length} session{filteredRecords.length === 1 ? "" : "s"}
                                </h2>
                            </div>
                        </div>
                        <div className={styles.HistoryList}>
                            {filteredRecords.map((record) => {
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
                                                <strong>{formatTimestamp(record.finishedAt)}</strong>
                                                <small>
                                                    {getGrindSpot(record.session.grindSpotId).name} ·{" "}
                                                    {record.session.region.toUpperCase()} ·{" "}
                                                    {formatDuration(record.session.elapsedMs)}
                                                </small>
                                            </span>
                                            <span className={styles.HistoryValue}>
                                                <strong>{formatSilver(totals.netPerHour, true)}/h</strong>
                                                <small>{formatSilver(totals.net, true)} net</small>
                                            </span>
                                        </button>
                                        <button
                                            className={styles.DeleteButton}
                                            type="button"
                                            disabled={actionBusy}
                                            aria-label={`Delete ${getGrindSpot(record.session.grindSpotId).name} session from ${formatTimestamp(record.finishedAt)}`}
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
                                    <p className="eyebrow">Session detail</p>
                                    <h2>{getGrindSpot(selected.session.grindSpotId).name}</h2>
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
                                    <strong>{formatSilver(selectedTotals.netPerHour, true)}</strong>
                                </div>
                            </div>
                            <div className={styles.GarmothUpload}>
                                <div className={styles.UploadHeading}>
                                    <div>
                                        <span>Garmoth upload</span>
                                        <strong>
                                            {selected.garmothUploadStatus === "success"
                                                ? "Uploaded"
                                                : selected.garmothUploadStatus === "unknown"
                                                  ? "Confirmation unknown"
                                                  : "Ready for review"}
                                        </strong>
                                    </div>
                                    {selected.garmothUploadStatus !== null ? null : !garmothSettingsLoaded ? (
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
                                            disabled={
                                                actionBusy ||
                                                selected.garmothUploadStatus !== null ||
                                                !uploadPreview ||
                                                uploadPreview.unmatchedEntries.length > 0
                                            }
                                            onClick={uploadSelected}
                                        >
                                            {uploading ? "Uploading..." : "Upload to Garmoth"}
                                        </button>
                                    )}
                                </div>
                                {uploadPreview && (
                                    <div className={styles.UploadPreview}>
                                        <span>{uploadPreview.input.minutes} minutes</span>
                                        <span>{formatSilver(uploadPreview.input.total, true)} total</span>
                                        <span>{formatSilver(uploadPreview.input.hourly, true)}/h</span>
                                        <span>{uploadPreview.mappedDropCount} recorded drops</span>
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
