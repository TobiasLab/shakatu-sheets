import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { loadConsumablePresets } from "../../api/tauri";
import { type ConsumablePreset, validateConsumableItems } from "../../domain/consumablePreset";
import { createEntry, type SessionEntry, type SessionState } from "../../domain/session";
import { formatSilver } from "../../format";
import dialogStyles from "../../views/LiveSession/LiveSession.module.css";
import styles from "./ConsumablePresets.module.css";

export function ConsumablePresetPicker({
    session,
    disabled,
    onApply,
}: {
    session: SessionState;
    disabled: boolean;
    onApply: (snapshot: SessionState, entries: SessionEntry[]) => boolean | Promise<boolean>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const opener = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const [target, setTarget] = useState<SessionState | null>(null);
    const [presets, setPresets] = useState<ConsumablePreset[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const applying = useRef(false);
    const request = useRef(0);
    const selected = presets.find((preset) => preset.id === selectedId);
    const replacing = target?.entries.some((entry) => entry.garmothConsumableId !== undefined);

    useEffect(() => {
        if (disabled && !applying.current) dialog.current?.close();
    }, [disabled]);
    useEffect(
        () => () => {
            request.current += 1;
        },
        [],
    );

    async function load(snapshot: SessionState) {
        const generation = ++request.current;
        setLoading(true);
        setError("");
        setPresets([]);
        setSelectedId("");
        try {
            const loaded = isTauri() ? await loadConsumablePresets() : [];
            if (generation === request.current)
                setPresets(loaded.filter((preset) => preset.region === snapshot.region));
        } catch (reason) {
            if (generation === request.current) setError(`Could not load presets: ${String(reason)}`);
        } finally {
            if (generation === request.current) setLoading(false);
        }
    }

    async function apply() {
        if (!target || !selected || disabled || applying.current) return;
        setError("");
        try {
            validateConsumableItems(selected.items);
            if (selected.region !== target.region) throw new Error("Choose a preset for the session's region.");
            const entries = selected.items.map((item) => ({
                ...createEntry(item.name, item.quantity, item.unitPrice, "expense"),
                garmothConsumableId: item.itemId,
            }));
            applying.current = true;
            setBusy(true);
            const applied = await onApply(target, entries);
            if (applied === false) return;
            dialog.current?.close();
            opener.current?.focus();
        } catch (reason) {
            setError(String(reason instanceof Error ? reason.message : reason));
        } finally {
            applying.current = false;
            setBusy(false);
        }
    }

    return (
        <>
            <button
                className="button"
                type="button"
                ref={opener}
                disabled={disabled || busy}
                onClick={() => {
                    setTarget(session);
                    dialog.current?.showModal();
                    void load(session);
                }}
            >
                Apply preset
            </button>
            <dialog
                ref={dialog}
                className={dialogStyles.ToolDialog}
                aria-labelledby={titleId}
                onCancel={(event) => {
                    if (applying.current) event.preventDefault();
                }}
            >
                <header className={dialogStyles.DialogHeading}>
                    <h2 id={titleId}>Select consumable preset</h2>
                    <button
                        type="button"
                        className="button subtle"
                        disabled={busy}
                        onClick={() => dialog.current?.close()}
                    >
                        Close <kbd>Esc</kbd>
                    </button>
                </header>
                <div className={`${styles.Root} ${styles.Editor}`}>
                    {loading && <p role="status">Loading presets…</p>}
                    {!loading && !error && presets.length === 0 && (
                        <p>
                            No {target?.region.toUpperCase()} presets. Add one in Settings → Integrations → Consumable
                            presets.
                        </p>
                    )}
                    <div className={styles.PresetList}>
                        {presets.map((preset) => (
                            <button
                                key={preset.id}
                                type="button"
                                className="button"
                                aria-pressed={selectedId === preset.id}
                                disabled={busy || disabled}
                                onClick={() => {
                                    setSelectedId(preset.id);
                                    setError("");
                                }}
                            >
                                <strong>{preset.name}</strong>
                                <span>
                                    {preset.items.length} consumables ·{" "}
                                    {formatSilver(
                                        preset.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
                                    )}{" "}
                                    silver
                                </span>
                            </button>
                        ))}
                    </div>
                    {selected && (
                        <>
                            <ul className={styles.PresetItems}>
                                {selected.items.map((item) => (
                                    <li key={item.itemId}>
                                        <span>
                                            {item.name} × {item.quantity}
                                        </span>
                                        <span>{formatSilver(item.quantity * item.unitPrice)}</span>
                                    </li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                className="button primary-button"
                                disabled={busy || disabled}
                                onClick={() => void apply()}
                            >
                                {busy ? "Applying…" : replacing ? "Replace session consumables" : "Add to session"}
                            </button>
                        </>
                    )}
                    {error && <p role="alert">{error}</p>}
                    {error && presets.length === 0 && target && (
                        <button
                            type="button"
                            className="button"
                            disabled={loading || busy}
                            onClick={() => void load(target)}
                        >
                            Retry
                        </button>
                    )}
                </div>
            </dialog>
        </>
    );
}
