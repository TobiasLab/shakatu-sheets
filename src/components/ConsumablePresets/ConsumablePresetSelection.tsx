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
    selectedId = "",
    onApply,
}: {
    session: SessionState;
    disabled: boolean;
    selectedId?: string;
    onApply: (entries: SessionEntry[], presetId: string) => boolean | Promise<boolean>;
}) {
    const [presets, setPresets] = useState<ConsumablePreset[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [reload, setReload] = useState(0);
    const applying = useRef(false);
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
    async function apply(preset: ConsumablePreset) {
        if (preset.id === selectedId || disabled || applying.current) return;
        try {
            validateConsumableItems(preset.items);
            const entries = preset.items.map((item) => ({
                ...createEntry(item.name, item.quantity, item.unitPrice, "expense"),
                garmothConsumableId: item.itemId,
            }));
            applying.current = true;
            setBusy(true);
            setError("");
            await onApply(entries, preset.id);
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
                        onClick={() => void apply(preset)}
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
