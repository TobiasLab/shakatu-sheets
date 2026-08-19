import type { SessionEntry } from "../../domain/session";
import { formatSilver } from "../../format";
import styles from "./LootLedger.module.css";

export function LootLedger({
    entries,
    editingDisabled,
    onRemove,
}: {
    entries: SessionEntry[];
    editingDisabled: boolean;
    onRemove: (id: string) => void;
}) {
    return (
        <section className="panel">
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Session entries</p>
                    <h2>Loot ledger</h2>
                </div>
                <span>{entries.length} entries</span>
            </div>
            {entries.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-glyph">+</div>
                    <strong>No loot recorded yet</strong>
                    <p>Start the timer and add drops as they arrive.</p>
                </div>
            ) : (
                <div className={styles.LedgerList}>
                    {entries
                        .slice()
                        .reverse()
                        .map((entry) => (
                            <div className={styles.LedgerRow} key={entry.id}>
                                <div className={`item-swatch ${entry.valuation}`}>
                                    {entry.valuation === "expense" ? "-" : "+"}
                                </div>
                                <div className={styles.ItemName}>
                                    <strong>{entry.name}</strong>
                                    <span>{entry.valuation}</span>
                                </div>
                                <span className={styles.Quantity}>x{formatSilver(entry.quantity)}</span>
                                <strong className={entry.valuation === "expense" ? "negative" : ""}>
                                    {entry.valuation === "expense" ? "-" : ""}
                                    {formatSilver(entry.quantity * entry.unitPrice, true)}
                                </strong>
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
                        ))}
                </div>
            )}
        </section>
    );
}
