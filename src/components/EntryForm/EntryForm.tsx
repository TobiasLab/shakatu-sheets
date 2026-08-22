import { type FormEvent, useRef, useState } from "react";
import { type DropTemplate, sycraiaDrops } from "../../data/grindSpots";
import type { Valuation } from "../../domain/session";
import { formatSilver } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./EntryForm.module.css";

type EntryFormProps = Pick<
    LiveSessionController,
    | "selectedDrop"
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
    const quantityInput = useRef<HTMLInputElement>(null);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visibleDrops = sycraiaDrops.filter((drop) => drop.name.toLocaleLowerCase().includes(normalizedQuery));

    function selectDrop(drop: DropTemplate) {
        chooseDrop(drop);
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
        addEntry(event);
        window.requestAnimationFrame(() => {
            quantityInput.current?.focus();
            quantityInput.current?.select();
        });
    }

    return (
        <aside className={`panel ${styles.EntryPanel}`}>
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Loot catalog</p>
                    <h2>Add to session</h2>
                </div>
                <span>{sycraiaDrops.length} items</span>
            </div>
            <div className={styles.EntryWorkspace}>
                <section className={styles.ItemPicker} aria-label="Sycraia loot items">
                    <label className={styles.SearchField}>
                        Find an item
                        <input
                            type="search"
                            value={query}
                            disabled={editingDisabled}
                            placeholder="Search Sycraia loot..."
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    <div className={styles.ItemList}>
                        {visibleDrops.map((drop) => (
                            <button
                                key={drop.name}
                                className={selectedDrop.name === drop.name ? styles.Selected : ""}
                                type="button"
                                disabled={editingDisabled}
                                aria-pressed={selectedDrop.name === drop.name}
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
                                    {selectedDrop.name === drop.name ? "Selected" : "Select"}
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
                        <span className={styles.SelectedIcon}>
                            <img src={selectedDrop.icon} alt="" />
                        </span>
                        <div>
                            <p className="eyebrow">Selected drop</p>
                            <strong>{selectedDrop.name}</strong>
                        </div>
                    </div>
                    <label>
                        Entry name
                        <input
                            value={customName}
                            disabled={editingDisabled}
                            placeholder={selectedDrop.name}
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
                                    min="0"
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
                    <p className={styles.DataNote}>
                        Matching items at the same price combine automatically. Edit totals directly in the ledger.
                    </p>
                </form>
            </div>
        </aside>
    );
}
