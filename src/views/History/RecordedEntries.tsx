import { getDropIcon } from "../../data/grindSpots";
import type { SessionState } from "../../domain/session";
import { formatSilver } from "../../format";
import styles from "./History.module.css";

export function RecordedEntries({ session }: { session: SessionState }) {
    return session.entries.length === 0 ? (
        <div className={`empty-state ${styles.HistoryEntriesEmpty}`}>
            <strong>No entries recorded</strong>
        </div>
    ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only recorded items need keyboard scrolling.
        <section className={styles.HistoryEntries} aria-label="Recorded items" tabIndex={0}>
            {session.entries.map((entry) => {
                const icon = getDropIcon(session.grindSpotId, entry.name);
                return (
                    <div className={styles.HistoryEntry} key={entry.id}>
                        {icon ? (
                            <img className={styles.ItemIcon} src={icon} alt="" width={28} height={28} />
                        ) : (
                            <div className={`item-swatch ${entry.valuation}`}>
                                {entry.valuation === "expense" ? "−" : "+"}
                            </div>
                        )}
                        <strong className={styles.EntryName}>{entry.name}</strong>
                        <span className={styles.EntryQuantity}>{formatSilver(entry.quantity)}</span>
                        <span className={styles.EntryPrice}>× {formatSilver(entry.unitPrice)}</span>
                        <strong className={`${styles.EntryValue} ${entry.valuation === "expense" ? "negative" : ""}`}>
                            {entry.valuation === "expense" ? "−" : ""}
                            {formatSilver(entry.quantity * entry.unitPrice, true)}
                        </strong>
                    </div>
                );
            })}
        </section>
    );
}
