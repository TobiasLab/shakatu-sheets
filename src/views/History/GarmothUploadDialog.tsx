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
                <h2 id={titleId}>Review Garmoth upload</h2>
                <button type="button" className="button subtle" disabled={busy} onClick={onClose}>
                    Cancel <kbd>Esc</kbd>
                </button>
            </header>
            <div className={styles.Body}>
                <div className={styles.Summary}>
                    <strong>
                        {grindSpots.find((spot) => spot.id === draft.grindSpotId)?.name ?? draft.grindSpotId}
                    </strong>
                    <span>{formatTimestamp(record.finishedAt)}</span>
                    <span>
                        {draft.region.toUpperCase()} · {formatDuration(draft.elapsedMs)} · {characterName}
                    </span>
                </div>
                <LootLedger
                    entries={draft.entries}
                    grindSpotId={draft.grindSpotId}
                    editingDisabled
                    onRemove={() => {}}
                    onUpdate={() => {}}
                    tools={null}
                />
                <section aria-label="Consumables" className={styles.Presets}>
                    {preview?.consumableCount === 0 && <p>No consumable preset applied.</p>}
                    {canSelect && (
                        <button
                            className="button"
                            type="button"
                            disabled={busy || blocked}
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
                    {selecting && (
                        <ConsumablePresetSelection
                            session={draft}
                            disabled={busy || blocked}
                            onApply={(entries) => {
                                setConsumables(entries);
                                setSelecting(false);
                                return true;
                            }}
                        />
                    )}
                </section>
                <div className={styles.Totals}>
                    <span>
                        Expenses <strong>{formatSilver(totals.expenses)}</strong>
                    </span>
                    <span>
                        Net silver <strong>{formatSilver(totals.net, true)}</strong>
                    </span>
                    <span>
                        Silver/h <strong>{formatSilver(totals.netPerHour, true)}</strong>
                    </span>
                </div>
                <fieldset className={styles.Options} disabled={busy || blocked}>
                    <legend>Upload options</legend>
                    <label className={styles.Checkbox}>
                        <input type="checkbox" checked={global} onChange={(event) => setGlobal(event.target.checked)} />
                        Contribute to global data
                    </label>
                    <label className={styles.Checkbox}>
                        <input
                            type="checkbox"
                            checked={usedAgris}
                            onChange={(event) => setUsedAgris(event.target.checked)}
                        />
                        Used Agris
                    </label>
                    {usedAgris && (
                        <label>
                            Agris amount
                            <input
                                type="number"
                                min="1"
                                step="1"
                                placeholder="Unknown"
                                value={agrisAmount}
                                onChange={(event) => setAgrisAmount(event.target.value)}
                            />
                        </label>
                    )}
                    <label>
                        Drop rate %
                        <input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Not specified"
                            value={dropRate}
                            onChange={(event) => setDropRate(event.target.value)}
                        />
                    </label>
                </fieldset>
                {(error || previewError) && <p role="alert">{error || previewError}</p>}
                <footer className={styles.Actions}>
                    <button type="button" className="button" disabled={busy} onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="button primary-button"
                        disabled={busy || blocked || !!previewError}
                        onClick={() => void upload()}
                    >
                        {busy ? "Uploading…" : repeat ? "Upload again" : "Upload to Garmoth"}
                    </button>
                </footer>
            </div>
        </dialog>
    );
}
