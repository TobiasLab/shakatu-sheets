import { type KeyboardEvent, useEffect, useState } from "react";
import { getSycraiaDropIcon } from "../../data/grindSpots";
import type { SessionEntry } from "../../domain/session";
import { formatSilver } from "../../format";
import styles from "./LootLedger.module.css";

function LedgerEntryRow({
    entry,
    editingDisabled,
    onRemove,
    onUpdate,
}: {
    entry: SessionEntry;
    editingDisabled: boolean;
    onRemove: (id: string) => void;
    onUpdate: (id: string, quantity: number, unitPrice: number) => void;
}) {
    const [quantity, setQuantity] = useState(String(entry.quantity));
    const [unitPrice, setUnitPrice] = useState(String(entry.unitPrice));
    const icon = getSycraiaDropIcon(entry.name);

    useEffect(() => {
        setQuantity(String(entry.quantity));
        setUnitPrice(String(entry.unitPrice));
    }, [entry.quantity, entry.unitPrice]);

    function commitEdit() {
        const parsedQuantity = Number(quantity);
        const parsedUnitPrice = Number(unitPrice);
        if (
            !Number.isSafeInteger(parsedQuantity) ||
            parsedQuantity <= 0 ||
            !Number.isSafeInteger(parsedUnitPrice) ||
            parsedUnitPrice < 0
        ) {
            setQuantity(String(entry.quantity));
            setUnitPrice(String(entry.unitPrice));
            return;
        }
        if (parsedQuantity !== entry.quantity || parsedUnitPrice !== entry.unitPrice) {
            onUpdate(entry.id, parsedQuantity, parsedUnitPrice);
        }
    }

    function handleEditKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
            event.preventDefault();
            setQuantity(String(entry.quantity));
            setUnitPrice(String(entry.unitPrice));
        }
    }

    return (
        <div className={styles.LedgerRow}>
            {icon ? (
                <span className={styles.ItemIcon}>
                    <img src={icon} alt="" />
                </span>
            ) : (
                <div className={`item-swatch ${entry.valuation}`}>{entry.valuation === "expense" ? "-" : "+"}</div>
            )}
            <div className={styles.RowContent}>
                <div className={styles.RowHeading}>
                    <div className={styles.ItemName}>
                        <strong title={entry.name}>{entry.name}</strong>
                        <span>{entry.valuation}</span>
                    </div>
                    <strong className={`${styles.EntryValue} ${entry.valuation === "expense" ? "negative" : ""}`}>
                        {entry.valuation === "expense" ? "-" : ""}
                        {formatSilver(entry.quantity * entry.unitPrice, true)}
                    </strong>
                </div>
                <div className={styles.EntryEditor}>
                    <label>
                        Qty
                        <input
                            type="number"
                            min="1"
                            step="1"
                            value={quantity}
                            disabled={editingDisabled}
                            aria-label={`Quantity for ${entry.name}`}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => setQuantity(event.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={handleEditKey}
                        />
                    </label>
                    <label>
                        Each
                        <input
                            type="number"
                            min="0"
                            step="1"
                            value={unitPrice}
                            disabled={editingDisabled}
                            aria-label={`Unit price for ${entry.name}`}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => setUnitPrice(event.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={handleEditKey}
                        />
                    </label>
                </div>
            </div>
            <button
                className={styles.RemoveButton}
                type="button"
                disabled={editingDisabled}
                aria-label={`Remove ${entry.name}`}
                onClick={() => onRemove(entry.id)}
            >
                x
            </button>
        </div>
    );
}

export function LootLedger({
    entries,
    editingDisabled,
    onRemove,
    onUpdate,
}: {
    entries: SessionEntry[];
    editingDisabled: boolean;
    onRemove: (id: string) => void;
    onUpdate: (id: string, quantity: number, unitPrice: number) => void;
}) {
    return (
        <section className={`panel ${styles.LedgerPanel}`}>
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Session entries</p>
                    <h2>Loot ledger</h2>
                </div>
                <span>{entries.length} items</span>
            </div>
            {entries.length === 0 ? (
                <div className={styles.EmptyLedger}>
                    <div className="empty-glyph">+</div>
                    <strong>No loot recorded yet</strong>
                    <p>Select a drop from the catalog and add it to this session.</p>
                </div>
            ) : (
                <div className={styles.LedgerList}>
                    {entries
                        .slice()
                        .reverse()
                        .map((entry) => (
                            <LedgerEntryRow
                                key={entry.id}
                                entry={entry}
                                editingDisabled={editingDisabled}
                                onRemove={onRemove}
                                onUpdate={onUpdate}
                            />
                        ))}
                </div>
            )}
        </section>
    );
}
