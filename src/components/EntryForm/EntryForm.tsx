import { type FormEvent, useRef, useState } from "react";
import type { DropTemplate } from "../../data/grindSpots";
import type { Valuation } from "../../domain/session";
import { formatSilver } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import { Feedback } from "../Feedback/Feedback";
import { FormField } from "../FormField/FormField";
import { SelectionButton } from "../SelectionButton/SelectionButton";
import styles from "./EntryForm.module.css";

type EntryFormProps = Pick<
    LiveSessionController,
    | "selectedDrop"
    | "spot"
    | "drops"
    | "editingDisabled"
    | "chooseDrop"
    | "addEntry"
    | "customName"
    | "setCustomName"
    | "quantity"
    | "setQuantity"
    | "unitPrice"
    | "setUnitPrice"
    | "valuation"
    | "setValuation"
    | "market"
>;

export function EntryForm({
    selectedDrop,
    spot,
    drops,
    editingDisabled,
    chooseDrop,
    addEntry,
    customName,
    setCustomName,
    quantity,
    setQuantity,
    unitPrice,
    setUnitPrice,
    valuation,
    setValuation,
    market,
}: EntryFormProps) {
    const [query, setQuery] = useState("");
    const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const nameInput = useRef<HTMLInputElement>(null);
    const quantityInput = useRef<HTMLInputElement>(null);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleDrops = drops.filter((drop) => drop.name.toLocaleLowerCase().includes(normalizedQuery));
    const expenseMode = valuation === "expense";
    const parsedQuantity = Number(quantity);
    const parsedPrice = Number(unitPrice);
    const lineValue =
        quantity.trim() && unitPrice.trim() && Number.isFinite(parsedQuantity) && Number.isFinite(parsedPrice)
            ? parsedQuantity * parsedPrice * (valuation === "market" ? 0.845 : 1)
            : null;

    function listedPrice(drop: DropTemplate) {
        const marketPrice = market.marketPrices?.find((price) => price.itemId === drop.marketItemId)?.basePrice;
        return marketPrice ?? drop.unitPrice;
    }

    function recordExpense() {
        setValuation("expense");
        setCustomName("");
        setQuantity("1");
        setUnitPrice("");
        setFeedback(null);
        nameInput.current?.focus();
    }

    function selectDrop(drop: DropTemplate) {
        chooseDrop(drop);
        setFeedback(null);
        quantityInput.current?.focus();
        quantityInput.current?.select();
    }

    function incrementQuantity(amount: number) {
        setFeedback(null);
        const currentQuantity = Number(quantity);
        const baseQuantity = Number.isSafeInteger(currentQuantity) && currentQuantity >= 0 ? currentQuantity : 0;
        setQuantity(String(baseQuantity + amount));
        quantityInput.current?.focus();
    }

    function submitEntry(event: FormEvent<HTMLFormElement>) {
        const error = addEntry(event);
        setFeedback({
            text:
                error ??
                `Added ${formatSilver(Number(quantity))} × ${customName.trim() || selectedDrop.name} to the ledger.`,
            error: error !== null,
        });
        if (error) return;
        window.requestAnimationFrame(() => {
            quantityInput.current?.focus();
            quantityInput.current?.select();
        });
    }

    return (
        <aside className={`panel ${styles.EntryPanel}`} data-mode={expenseMode ? "expense" : "loot"}>
            <div className={styles.Toolbar}>
                <fieldset className="segmented">
                    <legend className="sr-only">Entry type</legend>
                    <button
                        type="button"
                        aria-pressed={!expenseMode}
                        disabled={editingDisabled}
                        onClick={() => {
                            chooseDrop(selectedDrop);
                            setFeedback(null);
                            searchInput.current?.focus();
                        }}
                    >
                        Loot
                    </button>
                    <button type="button" aria-pressed={expenseMode} disabled={editingDisabled} onClick={recordExpense}>
                        Expense
                    </button>
                </fieldset>
                <span>
                    {expenseMode ? "Costs subtract from session net." : `${drops.length} items from ${spot.name}`}
                </span>
            </div>
            <div className={styles.EntryWorkspace}>
                <section className={styles.ItemPicker} aria-label={`${spot.name} loot items`} hidden={expenseMode}>
                    <label className={styles.SearchField}>
                        <span className="sr-only">Find an item</span>
                        <input
                            ref={searchInput}
                            type="search"
                            value={query}
                            disabled={editingDisabled}
                            placeholder={`Search ${spot.name} loot…`}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    <div className={styles.ItemList}>
                        {visibleDrops.map((drop) => {
                            const price = listedPrice(drop);
                            const selected = !expenseMode && selectedDrop.name === drop.name;
                            return (
                                <SelectionButton
                                    key={drop.name}
                                    disabled={editingDisabled}
                                    selected={selected}
                                    onClick={() => selectDrop(drop)}
                                >
                                    <span className={styles.ItemIcon}>
                                        <img src={drop.icon} alt="" />
                                    </span>
                                    <strong className={styles.ItemName}>{drop.name}</strong>
                                    <span className={styles.ItemKind}>
                                        {drop.valuation === "market" ? "Market" : "Vendor"}
                                    </span>
                                    <span className={styles.ItemPrice}>
                                        {price === null ? "—" : formatSilver(price, true)}
                                    </span>
                                </SelectionButton>
                            );
                        })}
                        {visibleDrops.length === 0 && (
                            <div className={styles.NoResults}>
                                <strong>No matching loot</strong>
                                <button
                                    className="button subtle"
                                    type="button"
                                    onClick={() => {
                                        setQuery("");
                                        searchInput.current?.focus();
                                    }}
                                >
                                    Clear search
                                </button>
                            </div>
                        )}
                    </div>
                </section>
                <form className={styles.Form} onSubmit={submitEntry} onChange={() => setFeedback(null)}>
                    {expenseMode ? (
                        <div className={styles.SelectedDrop}>
                            <div>
                                <strong>Record a cost</strong>
                                <small>Food, elixirs, repairs, or anything else spent on this session.</small>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.SelectedDrop}>
                            <span className={styles.SelectedIcon}>
                                <img src={selectedDrop.icon} alt="" />
                            </span>
                            <div>
                                <strong>{selectedDrop.name}</strong>
                                <small>
                                    {valuation === "market" ? "Market · 84.5% after tax" : "Vendor · full value"}
                                </small>
                            </div>
                        </div>
                    )}
                    <FormField label="Entry name">
                        <input
                            ref={nameInput}
                            value={customName}
                            disabled={editingDisabled}
                            required={valuation === "expense"}
                            placeholder={valuation === "expense" ? "e.g. Elixir rotation" : selectedDrop.name}
                            onChange={(event) => setCustomName(event.target.value)}
                        />
                    </FormField>
                    <div className={styles.FormRow}>
                        <div className={styles.QuantityControl}>
                            <FormField label="Quantity">
                                <input
                                    ref={quantityInput}
                                    type="number"
                                    min="1"
                                    step="1"
                                    required
                                    value={quantity}
                                    disabled={editingDisabled}
                                    onFocus={(event) => event.currentTarget.select()}
                                    onChange={(event) => setQuantity(event.target.value)}
                                />
                            </FormField>
                            <fieldset className={styles.QuantitySteps}>
                                <legend>Quick quantity increments</legend>
                                {[1, 10, 100, 1_000].map((amount) => (
                                    <button
                                        key={amount}
                                        type="button"
                                        disabled={editingDisabled}
                                        aria-label={`Increase quantity by ${amount}`}
                                        onClick={() => incrementQuantity(amount)}
                                    >
                                        +{amount === 1_000 ? "1K" : amount}
                                    </button>
                                ))}
                            </fieldset>
                        </div>
                        <FormField label="Unit price">
                            <input
                                type="number"
                                min="0"
                                step="1"
                                required
                                value={unitPrice}
                                disabled={editingDisabled}
                                placeholder="Required"
                                onChange={(event) => setUnitPrice(event.target.value)}
                            />
                        </FormField>
                    </div>
                    {!expenseMode && (
                        <FormField label="Valuation">
                            <select
                                value={valuation}
                                disabled={editingDisabled}
                                onChange={(event) => setValuation(event.target.value as Valuation)}
                            >
                                <option value="market">Market (84.5%)</option>
                                <option value="vendor">Vendor (100%)</option>
                                <option value="expense">Expense</option>
                            </select>
                        </FormField>
                    )}
                    <div className={styles.Submit}>
                        <span className={styles.LineValue} aria-live="polite">
                            {lineValue === null
                                ? ""
                                : expenseMode
                                  ? `Costs ${formatSilver(lineValue, true)}`
                                  : `Adds ${formatSilver(lineValue, true)}${valuation === "market" ? " after tax" : ""}`}
                        </span>
                        <button className="button primary-button" type="submit" disabled={editingDisabled}>
                            <span>Add to ledger</span>
                            <kbd>Enter</kbd>
                        </button>
                    </div>
                    {feedback && <Feedback tone={feedback.error ? "error" : "success"}>{feedback.text}</Feedback>}
                </form>
            </div>
        </aside>
    );
}
