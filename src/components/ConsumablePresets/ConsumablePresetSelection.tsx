import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { loadConsumablePresets } from "../../api/tauri";
import { type ConsumablePreset, validateConsumableItems } from "../../domain/consumablePreset";
import { createEntry, type SessionEntry, type SessionState } from "../../domain/session";
import { formatSilver } from "../../format";
import styles from "./ConsumablePresets.module.css";

export function ConsumablePresetSelection({
    session,
    disabled,
    onApply,
}: {
    session: SessionState;
    disabled: boolean;
    onApply: (entries: SessionEntry[]) => boolean | Promise<boolean>;
}) {
    const [presets, setPresets] = useState<ConsumablePreset[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [reload, setReload] = useState(0);
    const applying = useRef(false);
    const selected = presets.find((preset) => preset.id === selectedId);
    const replacing = session.entries.some((entry) => entry.garmothConsumableId !== undefined);
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError("");
        const load = isTauri() ? loadConsumablePresets() : Promise.resolve([]);
        void load
            .then((value) => {
                if (!cancelled) setPresets(value.filter((preset) => preset.region === session.region));
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(`Could not load presets: ${String(reason)}`);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [session.region, reload]);
    async function apply() {
        if (!selected || disabled || applying.current) return;
        try {
            validateConsumableItems(selected.items);
            const entries = selected.items.map((item) => ({
                ...createEntry(item.name, item.quantity, item.unitPrice, "expense"),
                garmothConsumableId: item.itemId,
            }));
            applying.current = true;
            setBusy(true);
            setError("");
            await onApply(entries);
        } catch (reason) {
            setError(String(reason instanceof Error ? reason.message : reason));
        } finally {
            applying.current = false;
            setBusy(false);
        }
    }
    return (
        <div className={`${styles.Root} ${styles.Editor}`}>
            {loading && <p role="status">Loading presets…</p>}
            {!loading && !error && presets.length === 0 && (
                <p>
                    No {session.region.toUpperCase()} presets. Add one in Settings → Integrations → Consumable presets.
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
                            {formatSilver(preset.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0))}{" "}
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
            {error && presets.length === 0 && (
                <button
                    type="button"
                    className="button"
                    disabled={loading || busy}
                    onClick={() => setReload((value) => value + 1)}
                >
                    Retry
                </button>
            )}
        </div>
    );
}
