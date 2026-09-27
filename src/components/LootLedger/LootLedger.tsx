import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { getDropIcon } from "../../data/grindSpots";
import { calculateQuantityPerHour, type SessionEntry, type SessionState } from "../../domain/session";
import { formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import { EmptyState, Feedback } from "../Feedback/Feedback";
import { Icon } from "../Icon/Icon";
import styles from "./LootLedger.module.css";

const quantityRateFormatter = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const quantityFormatter = new Intl.NumberFormat("en");

function parseWholeNumber(value: string) {
    return Number(value.replace(/,/g, "").trim());
}

function displayWholeNumber(value: string) {
    return /^\d+$/.test(value) ? quantityFormatter.format(Number(value)) : value;
}

function LedgerEntryRow({
    entry,
    elapsedMs,
    grindSpotId,
    editingDisabled,
    onRemove,
    onUpdate,
}: {
    entry: SessionEntry;
    elapsedMs: number;
    grindSpotId: string;
    editingDisabled: boolean;
    onRemove: (id: string) => void;
    onUpdate: (id: string, quantity: number, unitPrice: number) => void;
}) {
    const [quantity, setQuantity] = useState(String(entry.quantity));
    const [unitPrice, setUnitPrice] = useState(String(entry.unitPrice));
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<"quantity" | "price" | null>(null);
    const icon = getDropIcon(grindSpotId, entry.name);
    const quantityPerHour = calculateQuantityPerHour(entry.quantity, elapsedMs);
    const formattedQuantityRate = quantityPerHour === null ? "—" : quantityRateFormatter.format(quantityPerHour);

    useEffect(() => {
        setQuantity(String(entry.quantity));
        setUnitPrice(String(entry.unitPrice));
    }, [entry.quantity, entry.unitPrice]);

    function commitEdit() {
        setEditing(null);
        const parsedQuantity = parseWholeNumber(quantity);
        const parsedUnitPrice = parseWholeNumber(unitPrice);
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
                    type="text"
                    inputMode="numeric"
                    value={editing === "quantity" ? quantity : displayWholeNumber(quantity)}
                    disabled={editingDisabled}
                    aria-label={`Quantity for ${entry.name}`}
                    onFocus={(event) => {
                        setEditing("quantity");
                        event.currentTarget.value = quantity;
                        event.currentTarget.select();
                    }}
                    onChange={(event) => setQuantity(event.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={handleEditKey}
                />
            </td>
            <td className={styles.QuantityRate} title={formattedQuantityRate}>
                {formattedQuantityRate}
            </td>
            <td>
                <input
                    type="text"
                    inputMode="numeric"
                    value={editing === "price" ? unitPrice : displayWholeNumber(unitPrice)}
                    disabled={editingDisabled}
                    aria-label={`Unit price for ${entry.name}`}
                    onFocus={(event) => {
                        setEditing("price");
                        event.currentTarget.value = unitPrice;
                        event.currentTarget.select();
                    }}
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

function DropTile({
    name,
    icon,
    quantity,
    value,
    rate,
    announceNew,
}: {
    name: string;
    icon: string | undefined;
    quantity: number;
    value: number;
    rate: number | null;
    announceNew: boolean;
}) {
    const tile = useRef<HTMLLIElement>(null);
    const previous = useRef(announceNew ? 0 : quantity);
    // Briefly mark a tile when its quantity rises so new drops stand out at a glance.
    useEffect(() => {
        const element = tile.current;
        if (element && quantity > previous.current) {
            element.classList.remove(styles.Dropped);
            void element.offsetWidth;
            element.classList.add(styles.Dropped);
        }
        previous.current = quantity;
    }, [quantity]);
    return (
        <li ref={tile} className={styles.Tile} onAnimationEnd={() => tile.current?.classList.remove(styles.Dropped)}>
            {icon ? (
                <img src={icon} alt="" />
            ) : (
                <span className={`item-swatch ${styles.TileFallback}`} aria-hidden="true">
                    {name.slice(0, 2)}
                </span>
            )}
            <strong className={styles.TileQuantity}>{quantityFormatter.format(quantity)}</strong>
            <span className={styles.TileValue} title="Value after market tax">
                {formatSilver(value, true)}
            </span>
            <span className={styles.TileName} title={name}>
                {name}
            </span>
            <span className={styles.TileRate}>{rate === null ? "—" : `${quantityRateFormatter.format(rate)}/h`}</span>
        </li>
    );
}

function DropInventory({
    entries,
    grindSpotId,
    elapsedMs,
}: {
    entries: SessionEntry[];
    grindSpotId: string;
    elapsedMs: number;
}) {
    const drops = new Map<string, { quantity: number; value: number }>();
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    let expenseCount = 0;
    let expenseTotal = 0;
    for (const entry of entries) {
        const value = entry.quantity * entry.unitPrice * entry.saleMultiplier;
        if (entry.valuation === "expense") {
            expenseCount += 1;
            expenseTotal += entry.quantity * entry.unitPrice;
            continue;
        }
        const drop = drops.get(entry.name) ?? { quantity: 0, value: 0 };
        drops.set(entry.name, { quantity: drop.quantity + entry.quantity, value: drop.value + value });
    }
    return (
        <>
            <ul className={styles.Inventory} aria-label="Dropped items">
                {Array.from(drops, ([name, { quantity, value }]) => (
                    <DropTile
                        key={name}
                        name={name}
                        icon={getDropIcon(grindSpotId, name)}
                        quantity={quantity}
                        value={value}
                        rate={calculateQuantityPerHour(quantity, elapsedMs)}
                        announceNew={ready}
                    />
                ))}
            </ul>
            {drops.size === 0 && <p className={styles.InventoryNote}>No loot yet.</p>}
            {expenseCount > 0 && (
                <p className={styles.InventoryNote}>
                    {expenseCount === 1 ? "1 expense" : `${expenseCount} expenses`} ·{" "}
                    <span className="negative">−{formatSilver(expenseTotal, true)}</span>
                </p>
            )}
        </>
    );
}

export function LootLedger({
    title = "Loot ledger",
    mode = "ledger",
    switcher,
    tools,
    beforeEntries,
    loading = false,
    session,
    visible,
    editingDisabled,
    onRemove,
    onUpdate,
}: {
    title?: string;
    mode?: "inventory" | "ledger";
    switcher?: ReactNode;
    tools: ReactNode;
    beforeEntries?: ReactNode;
    loading?: boolean;
    session: SessionState;
    visible: boolean;
    editingDisabled: boolean;
    onRemove: (id: string) => void;
    onUpdate: (id: string, quantity: number, unitPrice: number) => void;
}) {
    const { entries, grindSpotId } = session;
    const elapsedMs = useElapsedTime(session, visible);
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
            <div className={`panel-heading ${styles.Heading}`}>
                <div className={styles.Title}>
                    <h2 id={headingId}>{title}</h2>
                    {switcher}
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
            ) : mode === "inventory" ? (
                <DropInventory entries={entries} grindSpotId={grindSpotId} elapsedMs={elapsedMs} />
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
                                        <th scope="col">Quantity/h</th>
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
                                            elapsedMs={elapsedMs}
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
