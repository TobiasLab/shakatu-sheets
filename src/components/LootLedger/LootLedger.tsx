import { getSycraiaDropIcon } from "../../data/grindSpots";
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
        <section className={`panel ${styles.LedgerPanel}`}>
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Session entries</p>
                    <h2>Loot ledger</h2>
                </div>
                <span>{entries.length} entries</span>
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
                        .map((entry) => {
                            const icon = getSycraiaDropIcon(entry.name);
                            return (
                                <div className={styles.LedgerRow} key={entry.id}>
                                    {icon ? (
                                        <span className={styles.ItemIcon}>
                                            <img src={icon} alt="" />
                                        </span>
                                    ) : (
                                        <div className={`item-swatch ${entry.valuation}`}>
                                            {entry.valuation === "expense" ? "-" : "+"}
                                        </div>
                                    )}
                                    <div className={styles.ItemName}>
                                        <strong title={entry.name}>{entry.name}</strong>
                                        <span>
                                            x{formatSilver(entry.quantity)} / {entry.valuation}
                                        </span>
                                    </div>
                                    <div className={styles.EntryValue}>
                                        <strong className={entry.valuation === "expense" ? "negative" : ""}>
                                            {entry.valuation === "expense" ? "-" : ""}
                                            {formatSilver(entry.quantity * entry.unitPrice, true)}
                                        </strong>
                                        <span>{formatSilver(entry.unitPrice, true)} ea.</span>
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
                        })}
                </div>
            )}
        </section>
    );
}
