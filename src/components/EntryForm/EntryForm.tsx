import { sycraiaLower } from "../../data/grindSpots";
import type { Valuation } from "../../domain/session";
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
    return (
        <aside className={`panel ${styles.EntryPanel}`}>
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Manual input</p>
                    <h2>Add to session</h2>
                </div>
            </div>
            <div className={styles.QuickItems}>
                <button
                    className={selectedDrop.name === sycraiaLower.trash.name ? styles.Selected : ""}
                    type="button"
                    disabled={editingDisabled}
                    onClick={() => chooseDrop(sycraiaLower.trash)}
                >
                    {sycraiaLower.trash.name}
                </button>
                {sycraiaLower.drops.map((drop) => (
                    <button
                        key={drop.name}
                        className={selectedDrop.name === drop.name ? styles.Selected : ""}
                        type="button"
                        disabled={editingDisabled}
                        onClick={() => chooseDrop(drop)}
                    >
                        {drop.name}
                    </button>
                ))}
            </div>
            <form className={styles.Form} onSubmit={addEntry}>
                <label>
                    Item or expense
                    <input
                        value={customName}
                        disabled={editingDisabled}
                        placeholder={selectedDrop.name}
                        onChange={(event) => setCustomName(event.target.value)}
                    />
                </label>
                <div className={styles.FormRow}>
                    <label>
                        Quantity
                        <input
                            type="number"
                            min="0"
                            step="1"
                            required
                            value={quantity}
                            disabled={editingDisabled}
                            onChange={(event) => setQuantity(event.target.value)}
                        />
                    </label>
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
                    Add entry
                </button>
            </form>
            <p className={styles.DataNote}>
                Saved market prices change only when you fetch them. Unit prices remain editable, and entries keep the
                price used when they were added.
            </p>
        </aside>
    );
}
