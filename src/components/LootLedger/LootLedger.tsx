import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { getDropIcon } from "../../data/grindSpots";
import type { SessionEntry } from "../../domain/session";
import { formatSilver } from "../../format";
import { EmptyState, Feedback } from "../Feedback/Feedback";
import { Icon } from "../Icon/Icon";
import styles from "./LootLedger.module.css";

function LedgerEntryRow({
    entry,
    grindSpotId,
    editingDisabled,
    onRemove,
    onUpdate,
}: {
    entry: SessionEntry;
    grindSpotId: string;
    editingDisabled: boolean;
    onRemove: (id: string) => void;
    onUpdate: (id: string, quantity: number, unitPrice: number) => void;
}) {
    const [quantity, setQuantity] = useState(String(entry.quantity));
    const [unitPrice, setUnitPrice] = useState(String(entry.unitPrice));
    const [error, setError] = useState("");
    const icon = getDropIcon(grindSpotId, entry.name);

    useEffect(() => {
        setQuantity(String(entry.quantity));
        setUnitPrice(String(entry.unitPrice));
    }, [entry.quantity, entry.unitPrice]);

    function commitEdit() {
        const parsedQuantity = Number(quantity);
        const parsedUnitPrice = Number(unitPrice);
        if (
            !quantity.trim() ||
            !unitPrice.trim() ||
            !Number.isSafeInteger(parsedQuantity) ||
            parsedQuantity <= 0 ||
            !Number.isSafeInteger(parsedUnitPrice) ||
            parsedUnitPrice < 0
        ) {
            setQuantity(String(entry.quantity));
            setUnitPrice(String(entry.unitPrice));
            setError("Edit not saved. Use whole numbers: quantity above 0, price 0 or more.");
            return;
        }
        if (entry.garmothConsumableId !== undefined && !Number.isSafeInteger(parsedQuantity * parsedUnitPrice)) {
            setQuantity(String(entry.quantity));
            setUnitPrice(String(entry.unitPrice));
            setError("Edit not saved. The consumable cost is too large.");
            return;
        }
        setError("");
        if (parsedQuantity !== entry.quantity || parsedUnitPrice !== entry.unitPrice)
            onUpdate(entry.id, parsedQuantity, parsedUnitPrice);
    }

    function handleEditKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
            event.preventDefault();
            setQuantity(String(entry.quantity));
            setUnitPrice(String(entry.unitPrice));
            setError("");
        }
    }

    return (
        <tr className={styles.LedgerRow}>
            <td>
                <div className={styles.ItemCell}>
                    {icon ? (
                        <span className={styles.ItemIcon}>
                            <img src={icon} alt="" />
                        </span>
                    ) : (
                        <span className={`item-swatch ${entry.valuation}`}>
                            {entry.valuation === "expense" ? "−" : "+"}
                        </span>
                    )}
                    <div className={styles.ItemName}>
                        <strong>{entry.name}</strong>
                        <span>
                            {entry.valuation === "market"
                                ? `Market · ${Math.round(entry.saleMultiplier * 1000) / 10}% kept`
                                : entry.valuation === "expense"
                                  ? "Expense"
                                  : `Vendor · ${Math.round(entry.saleMultiplier * 1000) / 10}% kept`}
                            {entry.source === "recognition" ? " · Auto" : ""}
                        </span>
                        {error && (
                            <small className={styles.EditError} role="alert">
                                {error}
                            </small>
                        )}
                    </div>
                </div>
            </td>
            <td>
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
            </td>
            <td>
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
            </td>
            <td className={`${styles.EntryValue} ${entry.valuation === "expense" ? "negative" : ""}`}>
                {entry.valuation === "expense" ? "−" : ""}
                {formatSilver(entry.quantity * entry.unitPrice, true)}
            </td>
            <td>
                <button
                    className={styles.RemoveButton}
                    type="button"
                    disabled={editingDisabled}
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => onRemove(entry.id)}
                >
                    <Icon name="trash" size={15} />
                </button>
            </td>
        </tr>
    );
}

export function LootLedger({
    tools,
    beforeEntries,
    loading = false,
    entries,
    grindSpotId,
    editingDisabled,
    onRemove,
    onUpdate,
}: {
    tools: ReactNode;
    beforeEntries?: ReactNode;
    loading?: boolean;
    entries: SessionEntry[];
    grindSpotId: string;
    editingDisabled: boolean;
    onRemove: (id: string) => void;
    onUpdate: (id: string, quantity: number, unitPrice: number) => void;
}) {
    const headingId = useId();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleEntries = entries.filter(
        (entry) =>
            entry.name.toLocaleLowerCase().includes(normalizedQuery) &&
            (filter === "all" ||
                (filter === "expense" ? entry.valuation === "expense" : entry.valuation !== "expense")),
    );
    return (
        <section className={`panel ${styles.LedgerPanel}`} aria-labelledby={headingId} aria-busy={loading}>
            <div className="panel-heading">
                <div>
                    <h2 id={headingId}>Loot ledger</h2>
                </div>
                {tools}
            </div>
            {beforeEntries}
            {loading ? (
                <Feedback>Reading session entries…</Feedback>
            ) : entries.length === 0 ? (
                <EmptyState title={editingDisabled ? "No recorded entries" : "No loot yet"}>
                    {editingDisabled
                        ? "This session has no recorded loot or expenses."
                        : "Set up capture or add your first item."}
                </EmptyState>
            ) : (
                <>
                    <div className={styles.LedgerToolbar}>
                        <label className={styles.Search}>
                            <span className="sr-only">Search ledger</span>
                            <input
                                type="search"
                                placeholder="Search recorded items…"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </label>
                        <label>
                            <span className="sr-only">Filter ledger</span>
                            <select
                                id={`ledger-filter-${headingId}`}
                                value={filter}
                                onChange={(event) => setFilter(event.target.value)}
                            >
                                <option value="all">All entries</option>
                                <option value="loot">Loot only</option>
                                <option value="expense">Expenses only</option>
                            </select>
                        </label>
                    </div>
                    {visibleEntries.length === 0 ? (
                        <div className={styles.NoResults}>
                            <strong>No matching entries</strong>
                            <button
                                className="button subtle"
                                type="button"
                                onClick={() => {
                                    setQuery("");
                                    setFilter("all");
                                }}
                            >
                                Clear filters
                            </button>
                        </div>
                    ) : (
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable table needs keyboard scrolling in read-only sessions.
                        <section className={styles.LedgerList} tabIndex={0} aria-label="Recorded loot and expenses">
                            <table>
                                <caption className="sr-only">
                                    {editingDisabled
                                        ? "Recorded loot and expenses, read only."
                                        : "Session entries. Quantity and unit price can be edited; Enter saves, Escape cancels."}
                                </caption>
                                <thead>
                                    <tr>
                                        <th scope="col">Item</th>
                                        <th scope="col">Quantity</th>
                                        <th scope="col">Unit price</th>
                                        <th scope="col">Gross silver</th>
                                        <th scope="col">
                                            <span className="sr-only">Remove</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleEntries.reverse().map((entry) => (
                                        <LedgerEntryRow
                                            key={entry.id}
                                            entry={entry}
                                            grindSpotId={grindSpotId}
                                            editingDisabled={editingDisabled}
                                            onRemove={onRemove}
                                            onUpdate={onUpdate}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}
                    <div className={styles.LedgerNote}>
                        <span>
                            {visibleEntries.length} of {entries.length} entries
                        </span>
                        <span>
                            {editingDisabled
                                ? "Finished session · read only"
                                : "Edit in place · Enter to save · Esc to cancel"}
                        </span>
                    </div>
                </>
            )}
        </section>
    );
}
