import { type FormEvent, useRef, useState } from "react";
import type { DropTemplate } from "../../data/grindSpots";
import type { Valuation } from "../../domain/session";
import { formatSilver } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
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
}: EntryFormProps) {
    const [query, setQuery] = useState("");
    const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
    const nameInput = useRef<HTMLInputElement>(null);
    const quantityInput = useRef<HTMLInputElement>(null);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleDrops = drops.filter((drop) => drop.name.toLocaleLowerCase().includes(normalizedQuery));

    function selectDrop(drop: DropTemplate) {
        chooseDrop(drop);
        setFeedback(null);
        quantityInput.current?.focus();
        quantityInput.current?.select();
    }

    function incrementQuantity(amount: number) {
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
        <aside className={`panel ${styles.EntryPanel}`}>
            <div className="panel-heading">
                <h3>Loot catalog</h3>
                <button
                    className="button subtle"
                    type="button"
                    disabled={editingDisabled}
                    onClick={() => {
                        setValuation("expense");
                        setCustomName("");
                        setQuantity("1");
                        setUnitPrice("");
                        setFeedback(null);
                        nameInput.current?.focus();
                    }}
                >
                    Record an expense
                </button>
            </div>
            <div className={styles.EntryWorkspace}>
                <section className={styles.ItemPicker} aria-label={`${spot.name} loot items`}>
                    <label className={styles.SearchField}>
                        Find an item
                        <input
                            type="search"
                            value={query}
                            disabled={editingDisabled}
                            placeholder={`Search ${spot.name} loot...`}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    <div className={styles.ItemList}>
                        {visibleDrops.map((drop) => (
                            <button
                                key={drop.name}
                                className={
                                    valuation !== "expense" && selectedDrop.name === drop.name ? styles.Selected : ""
                                }
                                type="button"
                                disabled={editingDisabled}
                                aria-pressed={valuation !== "expense" && selectedDrop.name === drop.name}
                                onClick={() => selectDrop(drop)}
                            >
                                <span className={styles.ItemIcon}>
                                    <img src={drop.icon} alt="" />
                                </span>
                                <span className={styles.ItemCopy}>
                                    <strong>{drop.name}</strong>
                                    <small>
                                        {drop.valuation}
                                        {drop.unitPrice !== null && ` / ${formatSilver(drop.unitPrice, true)}`}
                                    </small>
                                </span>
                                <span className={styles.SelectItem} aria-hidden="true">
                                    {valuation !== "expense" && selectedDrop.name === drop.name ? "Selected" : "Select"}
                                </span>
                            </button>
                        ))}
                        {visibleDrops.length === 0 && (
                            <div className={styles.NoResults}>
                                <strong>No matching loot</strong>
                                <span>Use the entry name field to add a custom item or expense.</span>
                            </div>
                        )}
                    </div>
                </section>
                <form className={styles.Form} onSubmit={submitEntry}>
                    <div className={styles.SelectedDrop}>
                        {valuation !== "expense" && (
                            <span className={styles.SelectedIcon}>
                                <img src={selectedDrop.icon} alt="" />
                            </span>
                        )}
                        <div>
                            <p className="eyebrow">{valuation === "expense" ? "Session expense" : "Selected drop"}</p>
                            <strong>{valuation === "expense" ? "Record a cost" : selectedDrop.name}</strong>
                        </div>
                    </div>
                    <label>
                        Entry name
                        <input
                            ref={nameInput}
                            value={customName}
                            disabled={editingDisabled}
                            required={valuation === "expense"}
                            placeholder={valuation === "expense" ? "e.g. Elixir rotation" : selectedDrop.name}
                            onChange={(event) => setCustomName(event.target.value)}
                        />
                    </label>
                    <div className={styles.FormRow}>
                        <div className={styles.QuantityControl}>
                            <label>
                                Quantity
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
                            </label>
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
                        <label>
                            Unit price
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
                        </label>
                    </div>
                    <label>
                        Valuation
                        <select
                            value={valuation}
                            disabled={editingDisabled}
                            onChange={(event) => setValuation(event.target.value as Valuation)}
                        >
                            <option value="market">Market (84.5%)</option>
                            <option value="vendor">Vendor (100%)</option>
                            <option value="expense">Expense</option>
                        </select>
                    </label>
                    <button
                        className={`button primary-button ${styles.AddButton}`}
                        type="submit"
                        disabled={editingDisabled}
                    >
                        <span>Add to ledger</span>
                        <kbd>Enter</kbd>
                    </button>
                    {feedback && (
                        <p
                            className={`${styles.Feedback} ${feedback.error ? styles.Error : ""}`}
                            role={feedback.error ? "alert" : "status"}
                        >
                            {feedback.text}
                        </p>
                    )}
                    <p className={styles.DataNote}>
                        Matching items at the same price combine automatically. Edit totals directly in the ledger.
                    </p>
                </form>
            </div>
        </aside>
    );
}
