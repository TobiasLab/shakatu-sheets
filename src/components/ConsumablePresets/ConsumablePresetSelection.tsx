import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { loadConsumablePresets } from "../../api/tauri";
import { type ConsumablePreset, validateConsumableItems } from "../../domain/consumablePreset";
import { createEntry, type SessionEntry, type SessionState } from "../../domain/session";
import { formatSilver } from "../../format";
import { EmptyState, Feedback } from "../Feedback/Feedback";
import { SelectionButton } from "../SelectionButton/SelectionButton";
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
    onApply: (entries: SessionEntry[], presetId: string) => void | Promise<void>;
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
        setPresets([]);
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
            {loading && <Feedback>Loading presets…</Feedback>}
            {!loading && !error && presets.length === 0 && (
                <EmptyState title={`No ${session.region.toUpperCase()} presets`}>
                    Add one in Settings → Integrations → Consumable presets.
                </EmptyState>
            )}
            <div className={styles.PresetList}>
                {presets.map((preset) => (
                    <SelectionButton
                        key={preset.id}
                        className={styles.PresetRow}
                        selected={selectedId === preset.id}
                        disabled={loading || busy || disabled}
                        onClick={() => void apply(preset)}
                    >
                        <span className={styles.PresetIdentity}>
                            <strong>{preset.name}</strong>
                            <small>
                                {preset.items.length} {preset.items.length === 1 ? "consumable" : "consumables"}
                            </small>
                        </span>
                        <span className={styles.PresetCost}>
                            <strong>
                                −
                                {formatSilver(
                                    preset.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
                                    true,
                                )}
                            </strong>
                            {selectedId === preset.id && <small>Applied</small>}
                        </span>
                    </SelectionButton>
                ))}
            </div>
            {error && <Feedback tone="error">{error}</Feedback>}
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
