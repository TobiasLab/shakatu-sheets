import { isTauri } from "@tauri-apps/api/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { loadConsumablePresets, saveConsumablePresets } from "../../api/tauri";
import {
    type ConsumablePreset,
    type ConsumablePresetItem,
    parseConsumablePresetExport,
    validateConsumableItems,
} from "../../domain/consumablePreset";
import type { SessionState } from "../../domain/session";
import { formatSilver } from "../../format";
import styles from "./ConsumablePresets.module.css";

type DraftItem = { itemId: number; name: string; quantity: string; unitPrice: string };

// Known game item names; planner-only IDs remain visible for the user to name.
const knownNames: Record<number, string> = {
    9692: "Simple Cron Meal",
    1411: "Perfume of Envy",
    1407: "[Party] Harmony Draught - Edania",
    761879: "Adventure's Boon (60 min)",
    767969: "Blessing of Mystic Beasts - All AP",
};

function draftItems(items: ConsumablePresetItem[]): DraftItem[] {
    return items.map((item) => ({ ...item, quantity: String(item.quantity), unitPrice: String(item.unitPrice) }));
}

export function ConsumablePresetSettings({
    initialRegion,
    disabled: unavailable,
}: {
    initialRegion: SessionState["region"];
    disabled: boolean;
}) {
    const [region, setRegion] = useState(initialRegion);
    const [presets, setPresets] = useState<ConsumablePreset[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [reload, setReload] = useState(0);
    const [loadError, setLoadError] = useState("");
    const [selectedId, setSelectedId] = useState("");
    const [name, setName] = useState("");
    const [text, setText] = useState("");
    const [items, setItems] = useState<DraftItem[]>([]);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const saving = useRef(false);
    const alive = useRef(true);
    const desktop = isTauri();
    const disabled = unavailable || busy || !loaded;
    const regionalPresets = presets.filter((preset) => preset.region === region);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoadError("");
        setLoaded(false);
        if (!desktop) {
            setLoaded(true);
            return;
        }
        void loadConsumablePresets()
            .then((value) => {
                if (!cancelled) {
                    setPresets(value);
                    setLoaded(true);
                }
            })
            .catch((reason: unknown) => {
                if (!cancelled) setLoadError(`Could not load presets: ${String(reason)}`);
            });
        return () => {
            cancelled = true;
        };
    }, [desktop, reload]);

    function importPreset(event: FormEvent) {
        event.preventDefault();
        if (disabled) return;
        try {
            const parsed = parseConsumablePresetExport(text);
            setSelectedId("");
            setName(parsed.name);
            setItems(
                parsed.itemIds.map((itemId) => ({
                    itemId,
                    name: knownNames[itemId] ?? `Consumable ${itemId}`,
                    quantity: "",
                    unitPrice: "",
                })),
            );
            setText("");
            setError("");
            setMessage("");
        } catch (reason) {
            setError(String(reason instanceof Error ? reason.message : reason));
        }
    }

    function validatedDraft() {
        if (items.some((item) => !item.quantity.trim() || !item.unitPrice.trim()))
            throw new Error("Enter each session quantity and unit price. Use 0 for a free buff.");
        const result = items.map((item) => ({
            itemId: item.itemId,
            name: item.name.trim(),
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
        }));
        return { items: result, total: validateConsumableItems(result) };
    }

    function updateItem(itemId: number, field: "name" | "quantity" | "unitPrice", value: string) {
        setItems((current) => current.map((item) => (item.itemId === itemId ? { ...item, [field]: value } : item)));
        setMessage("");
    }

    async function persist(remove = false) {
        if (disabled || saving.current || !desktop) return;
        setError("");
        setMessage("");
        try {
            let id = selectedId;
            let next: ConsumablePreset[];
            if (remove) {
                if (!id || !window.confirm("Delete this saved preset? Session expenses are kept.")) return;
                next = presets.filter((preset) => preset.id !== id);
            } else {
                const trimmedName = name.trim();
                if (!trimmedName || trimmedName.length > 100)
                    throw new Error("Enter a preset name (1–100 characters).");
                if (regionalPresets.some((preset) => preset.name === trimmedName && preset.id !== id))
                    throw new Error("A preset with this name already exists. Select it to update it.");
                if (!id && presets.length >= 20) throw new Error("Save at most 20 presets. Delete one first.");
                id ||= crypto.randomUUID();
                const preset: ConsumablePreset = {
                    id,
                    name: trimmedName,
                    region,
                    items: validatedDraft().items,
                };
                next = [...presets.filter((candidate) => candidate.id !== id), preset];
            }
            saving.current = true;
            setBusy(true);
            await saveConsumablePresets(next);
            if (!alive.current) return;
            setPresets(next);
            setSelectedId(remove ? "" : id);
            setMessage(remove ? "Preset deleted." : "Preset saved.");
        } catch (reason) {
            if (alive.current) setError(String(reason instanceof Error ? reason.message : reason));
        } finally {
            saving.current = false;
            if (alive.current) setBusy(false);
        }
    }

    let total: number | null = null;
    try {
        total = validatedDraft().total;
    } catch {
        /* Incomplete drafts have no total. */
    }

    return (
        <div className={styles.Editor}>
            {loadError && (
                <div role="alert">
                    {loadError}{" "}
                    <button type="button" className="button" onClick={() => setReload((value) => value + 1)}>
                        Retry
                    </button>
                </div>
            )}
            {!loaded && !loadError && <p role="status">Loading presets…</p>}
            <label>
                Preset region
                <select
                    value={region}
                    disabled={disabled}
                    onChange={(event) => {
                        setRegion(event.target.value as SessionState["region"]);
                        setSelectedId("");
                        setName("");
                        setItems([]);
                        setError("");
                        setMessage("");
                    }}
                >
                    <option value="eu">EU</option>
                    <option value="na">NA</option>
                </select>
            </label>
            <label>
                Saved preset · {region.toUpperCase()}
                <select
                    value={selectedId}
                    disabled={disabled}
                    onChange={(event) => {
                        const id = event.target.value;
                        setSelectedId(id);
                        const preset = regionalPresets.find((candidate) => candidate.id === id);
                        if (preset) {
                            setName(preset.name);
                            setItems(draftItems(preset.items));
                        }
                        setError("");
                        setMessage("");
                    }}
                >
                    <option value="">Unsaved preset</option>
                    {regionalPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                            {preset.name}
                        </option>
                    ))}
                </select>
            </label>
            <details open={items.length === 0}>
                <summary>Import Garmoth export</summary>
                <form onSubmit={importPreset} className={styles.Editor}>
                    <label>
                        Preset JSON
                        <textarea
                            rows={4}
                            value={text}
                            maxLength={16_384}
                            required
                            disabled={disabled}
                            onChange={(event) => setText(event.target.value)}
                            placeholder={'{"name":"My preset","export":"9692,1411"}'}
                        />
                    </label>
                    <button type="submit" className="button" disabled={disabled}>
                        Read export
                    </button>
                </form>
            </details>
            {(items.length > 0 || selectedId) && (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void persist();
                    }}
                    className={styles.Editor}
                >
                    <label>
                        Preset name
                        <input
                            value={name}
                            maxLength={100}
                            disabled={disabled}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Allow keyboard scrolling of the overflowing table. */}
                    <section className={styles.TableScroll} aria-label="Consumable quantities and prices" tabIndex={0}>
                        <table>
                            <thead>
                                <tr>
                                    <th>Consumable</th>
                                    <th>Session quantity</th>
                                    <th>Unit price</th>
                                    <th>
                                        <span className={styles.Hidden}>Actions</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item) => (
                                    <tr key={item.itemId}>
                                        <td>
                                            <input
                                                aria-label={`Name for ${item.itemId}`}
                                                value={item.name}
                                                maxLength={100}
                                                required
                                                disabled={disabled}
                                                onChange={(event) =>
                                                    updateItem(item.itemId, "name", event.target.value)
                                                }
                                            />
                                            <small>ID {item.itemId}</small>
                                        </td>
                                        <td>
                                            <input
                                                aria-label={`Session quantity for ${item.name}`}
                                                type="number"
                                                min="1"
                                                max={Number.MAX_SAFE_INTEGER}
                                                step="1"
                                                required
                                                value={item.quantity}
                                                disabled={disabled}
                                                onChange={(event) =>
                                                    updateItem(item.itemId, "quantity", event.target.value)
                                                }
                                            />
                                        </td>
                                        <td>
                                            <input
                                                aria-label={`Unit price for ${item.name}`}
                                                type="number"
                                                min="0"
                                                max={Number.MAX_SAFE_INTEGER}
                                                step="1"
                                                required
                                                value={item.unitPrice}
                                                disabled={disabled}
                                                onChange={(event) =>
                                                    updateItem(item.itemId, "unitPrice", event.target.value)
                                                }
                                            />
                                        </td>
                                        <td>
                                            <button
                                                type="button"
                                                className="button subtle"
                                                disabled={disabled}
                                                aria-label={`Remove ${item.name}`}
                                                onClick={() =>
                                                    setItems((current) =>
                                                        current.filter((row) => row.itemId !== item.itemId),
                                                    )
                                                }
                                            >
                                                Remove
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                    <div className={styles.Actions}>
                        <strong>Expenses: {total === null ? "—" : formatSilver(total)}</strong>
                        <button
                            type="button"
                            className="button primary-button"
                            disabled={disabled || !desktop}
                            title={desktop ? undefined : "Preset saving requires the desktop app"}
                            onClick={() => void persist()}
                        >
                            {busy ? "Saving…" : "Save preset"}
                        </button>
                        {selectedId && (
                            <button
                                type="button"
                                className="button subtle"
                                disabled={disabled}
                                onClick={() => void persist(true)}
                            >
                                Delete preset
                            </button>
                        )}
                    </div>
                </form>
            )}
            {error && <p role="alert">{error}</p>}
            {message && <p role="status">{message}</p>}
        </div>
    );
}
