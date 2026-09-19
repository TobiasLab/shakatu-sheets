import { useEffect, useId, useRef, useState } from "react";
import { type FinishedSessionRecord, type GarmothUploadResult, uploadGarmothSession } from "../../api/tauri";
import { ConsumablePresetSelection } from "../../components/ConsumablePresets/ConsumablePresetSelection";
import { LootLedger } from "../../components/LootLedger/LootLedger";
import { grindSpots } from "../../data/grindSpots";
import { calculateTotals, type SessionEntry } from "../../domain/session";
import { formatDuration, formatSilver, formatTimestamp } from "../../format";
import { buildGarmothUpload, type GarmothUploadPreview, parseGarmothOptions } from "../../garmoth";
import dialogStyles from "../LiveSession/LiveSession.module.css";
import styles from "./GarmothUploadDialog.module.css";

export function GarmothUploadDialog({
    record,
    characterName,
    onClose,
    onBusy,
    onResult,
}: {
    record: FinishedSessionRecord;
    characterName: string;
    onClose: () => void;
    onBusy: (busy: boolean) => void;
    onResult: (result: GarmothUploadResult) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const sending = useRef(false);
    const [snapshot, setSnapshot] = useState(record.session);
    const [consumables, setConsumables] = useState<SessionEntry[] | null>(null);
    const [selecting, setSelecting] = useState(false);
    const [global, setGlobal] = useState(false);
    const [usedAgris, setUsedAgris] = useState(false);
    const [agrisAmount, setAgrisAmount] = useState("");
    const [dropRate, setDropRate] = useState("");
    const [busy, setBusy] = useState(false);
    const [blocked, setBlocked] = useState(record.garmothUploadStatus === "unknown");
    const [error, setError] = useState("");
    const [repeat] = useState(record.garmothUploadStatus === "success");
    const canSelect = !repeat || !snapshot.entries.some((entry) => entry.garmothConsumableId !== undefined);
    const draft = consumables
        ? {
              ...snapshot,
              entries: [...snapshot.entries.filter((entry) => entry.garmothConsumableId === undefined), ...consumables],
          }
        : snapshot;
    const totals = calculateTotals(draft.entries, draft.elapsedMs);
    let preview: GarmothUploadPreview | undefined;
    let previewError = "";
    try {
        preview = buildGarmothUpload(draft);
        if (preview.unmatchedEntries.length)
            previewError = `Unmapped loot: ${preview.unmatchedEntries.join(", ")}. Reopen the session to correct it.`;
    } catch (reason) {
        previewError = String(reason instanceof Error ? reason.message : reason);
    }
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        element?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
        return () => element?.close();
    }, []);

    async function upload() {
        if (sending.current || blocked || !preview || previewError) return;
        setError("");
        try {
            const options = parseGarmothOptions(global, usedAgris, agrisAmount, dropRate);
            if (repeat && !window.confirm("Upload this session again? This creates another session on Garmoth."))
                return;
            sending.current = true;
            setBusy(true);
            onBusy(true);
            const result = await uploadGarmothSession({
                ...preview.input,
                ...options,
                repeatUpload: repeat,
                expectedSession: snapshot,
                consumableEntries: consumables ?? undefined,
            });
            if (result.savedSession) {
                setSnapshot(result.savedSession);
                setConsumables(null);
            }
            onResult(result);
            if (result.status === "success") onClose();
            else {
                setBlocked(result.status === "unknown");
                setError(result.message);
            }
        } catch (reason) {
            setError(String(reason instanceof Error ? reason.message : reason));
        } finally {
            sending.current = false;
            setBusy(false);
            onBusy(false);
        }
    }

    const spot = grindSpots.find((candidate) => candidate.id === draft.grindSpotId);
    return (
        <dialog
            ref={dialog}
            className={`${dialogStyles.ToolDialog} ${styles.Dialog}`}
            aria-labelledby={titleId}
            onCancel={(event) => {
                event.preventDefault();
                if (!sending.current) onClose();
            }}
        >
            <header className={dialogStyles.DialogHeading}>
                <h2 id={titleId}>Upload to Garmoth</h2>
                <button
                    type="button"
                    className="button subtle"
                    aria-label="Close Garmoth upload"
                    disabled={busy}
                    onClick={onClose}
                >
                    Close <kbd>Esc</kbd>
                </button>
            </header>
            <div className={styles.Body}>
                <div className={styles.Location}>
                    {spot?.trash.icon && <img src={spot.trash.icon} alt="" width={40} height={40} />}
                    <div>
                        <h3>{spot?.name ?? draft.grindSpotId}</h3>
                        <div className={styles.Context}>
                            <span>{formatTimestamp(record.finishedAt)}</span>
                            <span>{draft.region.toUpperCase()}</span>
                            <span>{characterName}</span>
                        </div>
                    </div>
                </div>
                <section className={`${dialogStyles.MetricsGrid} ${styles.Metrics}`} aria-label="Session summary">
                    <div className={dialogStyles.Metric}>
                        <span>Net silver / hour</span>
                        <strong>{formatSilver(totals.netPerHour, true)}</strong>
                    </div>
                    <div className={dialogStyles.Metric}>
                        <span>Session net</span>
                        <strong>{formatSilver(totals.net, true)}</strong>
                        <small>Expenses {formatSilver(totals.expenses)}</small>
                    </div>
                    <div className={dialogStyles.Metric}>
                        <span>Session time</span>
                        <strong>{formatDuration(draft.elapsedMs)}</strong>
                    </div>
                </section>
                <LootLedger
                    entries={draft.entries}
                    grindSpotId={draft.grindSpotId}
                    editingDisabled
                    onRemove={() => {}}
                    onUpdate={() => {}}
                    tools={
                        <div className={dialogStyles.EntryTools}>
                            {preview?.consumableCount === 0 && (
                                <span className={styles.PresetStatus}>No preset applied</span>
                            )}
                            {canSelect && (
                                <button
                                    className="button"
                                    type="button"
                                    disabled={busy || blocked}
                                    aria-expanded={selecting}
                                    onClick={() => setSelecting(!selecting)}
                                >
                                    {selecting ? "Close preset selection" : "Select preset"}
                                </button>
                            )}
                            {consumables && (
                                <button
                                    className="button subtle"
                                    type="button"
                                    disabled={busy || blocked}
                                    onClick={() => setConsumables(null)}
                                >
                                    Undo preset selection
                                </button>
                            )}
                        </div>
                    }
                    beforeEntries={
                        selecting && (
                            <div className={styles.PresetSelection}>
                                <ConsumablePresetSelection
                                    session={draft}
                                    disabled={busy || blocked}
                                    onApply={(entries) => {
                                        setConsumables(entries);
                                        setSelecting(false);
                                        return true;
                                    }}
                                />
                            </div>
                        )
                    }
                />
                <fieldset className={styles.Options} disabled={busy || blocked}>
                    <legend className="sr-only">Upload options</legend>
                    <label className={styles.Checkbox}>
                        <input type="checkbox" checked={global} onChange={(event) => setGlobal(event.target.checked)} />
                        Contribute to global data
                    </label>
                    <div className={styles.Agris}>
                        <label className={styles.Checkbox}>
                            <input
                                type="checkbox"
                                checked={usedAgris}
                                onChange={(event) => setUsedAgris(event.target.checked)}
                            />
                            Used Agris
                        </label>
                        {usedAgris && (
                            <input
                                aria-label="Agris amount"
                                type="number"
                                min="1"
                                step="1"
                                placeholder="Unknown"
                                value={agrisAmount}
                                onChange={(event) => setAgrisAmount(event.target.value)}
                            />
                        )}
                    </div>
                    <label className={styles.Rate}>
                        Drop rate %
                        <input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="—"
                            value={dropRate}
                            onChange={(event) => setDropRate(event.target.value)}
                        />
                    </label>
                </fieldset>
                {(error || previewError) && (
                    <p className={styles.Error} role="alert">
                        {error || previewError}
                    </p>
                )}
            </div>
            <footer className={styles.Actions}>
                <button
                    type="button"
                    className="button primary-button"
                    disabled={busy || blocked || !!previewError}
                    onClick={() => void upload()}
                >
                    {busy ? "Uploading…" : repeat ? "Upload again" : "Upload to Garmoth"}
                </button>
            </footer>
        </dialog>
    );
}
