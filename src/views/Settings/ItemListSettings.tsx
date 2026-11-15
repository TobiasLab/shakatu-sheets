import { type FormEvent, useState } from "react";
import { Feedback } from "../../components/Feedback/Feedback";
import { FormField } from "../../components/FormField/FormField";
import { addGeneralItem, addIgnoredItem, type ItemLists, parseUnitPrice, unitPriceError } from "../../domain/itemLists";
import { formatSilver } from "../../format";
import type { PersistedSetting } from "../../hooks/usePersistedSetting";
import styles from "./ItemListSettings.module.css";

export function ItemListSettings({ itemLists }: { itemLists: PersistedSetting<ItemLists> }) {
    const [ignoredName, setIgnoredName] = useState("");
    const [itemName, setItemName] = useState("");
    const [unitPrice, setUnitPrice] = useState("");
    const [error, setError] = useState<{ list: "ignored" | "general"; message: string } | null>(null);
    // Only the focused price has a draft; the others show grouped digits like the ledger.
    const [priceDraft, setPriceDraft] = useState<{ name: string; value: string } | null>(null);
    const lists = itemLists.value;
    const disabled = !itemLists.loaded;

    function save(list: "ignored" | "general", next: ItemLists | string) {
        if (typeof next === "string") {
            setError({ list, message: next });
            return false;
        }
        setError(null);
        void itemLists.update(next);
        return true;
    }

    function ignore(event: FormEvent) {
        event.preventDefault();
        if (save("ignored", addIgnoredItem(lists, ignoredName))) setIgnoredName("");
    }

    function add(event: FormEvent) {
        event.preventDefault();
        if (save("general", addGeneralItem(lists, itemName, unitPrice))) {
            setItemName("");
            setUnitPrice("");
        }
    }

    function commitPrice() {
        if (!priceDraft) return;
        setPriceDraft(null);
        const { name, value } = priceDraft;
        const price = parseUnitPrice(value);
        const current = lists.generalItems.find((item) => item.name === name);
        if (!current || current.unitPrice === price) return;
        if (price === null) {
            setError({ list: "general", message: unitPriceError });
            return;
        }
        save("general", {
            ...lists,
            generalItems: lists.generalItems.map((item) => (item.name === name ? { ...item, unitPrice: price } : item)),
        });
    }

    return (
        <>
            <div className={styles.List}>
                <h3 id="ignored-items-title">Ignored items</h3>
                <p>Recognition skips these drops.</p>
                {lists.ignoredItems.length > 0 && (
                    <ul aria-labelledby="ignored-items-title">
                        {lists.ignoredItems.map((name) => (
                            <li key={name}>
                                <span>{name}</span>
                                <button
                                    type="button"
                                    className="button subtle"
                                    disabled={disabled}
                                    aria-label={`Stop ignoring ${name}`}
                                    onClick={() => {
                                        if (!window.confirm(`Stop ignoring ${name}? Its drops will be read again.`))
                                            return;
                                        save("ignored", {
                                            ...lists,
                                            ignoredItems: lists.ignoredItems.filter((item) => item !== name),
                                        });
                                    }}
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <form className={styles.AddForm} onSubmit={ignore}>
                    <FormField label="Item name" className={styles.NameField}>
                        <input
                            value={ignoredName}
                            maxLength={100}
                            required
                            disabled={disabled}
                            placeholder="Exact in-game name"
                            onChange={(event) => setIgnoredName(event.target.value)}
                        />
                    </FormField>
                    <button type="submit" className="button" disabled={disabled}>
                        Ignore item
                    </button>
                </form>
                {error?.list === "ignored" && <Feedback tone="error">{error.message}</Feedback>}
            </div>
            <div className={styles.List}>
                <h3 id="general-items-title">Items at every grind spot</h3>
                <p>Recognized and offered at every spot, at full vendor value.</p>
                {lists.generalItems.length > 0 && (
                    <table aria-labelledby="general-items-title">
                        <thead>
                            <tr>
                                <th scope="col">Item</th>
                                <th scope="col">Unit price</th>
                                <th scope="col">
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {lists.generalItems.map((item) => (
                                <tr key={item.name}>
                                    <td>{item.name}</td>
                                    <td>
                                        <input
                                            aria-label={`Unit price for ${item.name}`}
                                            type="text"
                                            inputMode="numeric"
                                            value={
                                                priceDraft?.name === item.name
                                                    ? priceDraft.value
                                                    : formatSilver(item.unitPrice)
                                            }
                                            disabled={disabled}
                                            onFocus={(event) => {
                                                setPriceDraft({ name: item.name, value: String(item.unitPrice) });
                                                event.currentTarget.value = String(item.unitPrice);
                                                event.currentTarget.select();
                                            }}
                                            onChange={(event) =>
                                                setPriceDraft({ name: item.name, value: event.target.value })
                                            }
                                            onBlur={commitPrice}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") event.currentTarget.blur();
                                                if (event.key === "Escape" && priceDraft) {
                                                    event.preventDefault();
                                                    setPriceDraft({ ...priceDraft, value: String(item.unitPrice) });
                                                }
                                            }}
                                        />
                                    </td>
                                    <td>
                                        <button
                                            type="button"
                                            className="button subtle"
                                            disabled={disabled}
                                            aria-label={`Remove ${item.name}`}
                                            onClick={() => {
                                                if (
                                                    !window.confirm(
                                                        `Remove ${item.name}? Recorded session entries are kept.`,
                                                    )
                                                )
                                                    return;
                                                save("general", {
                                                    ...lists,
                                                    generalItems: lists.generalItems.filter(
                                                        (candidate) => candidate.name !== item.name,
                                                    ),
                                                });
                                            }}
                                        >
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <form className={styles.AddForm} onSubmit={add}>
                    <FormField label="Item name" className={styles.NameField}>
                        <input
                            value={itemName}
                            maxLength={100}
                            required
                            disabled={disabled}
                            placeholder="Exact in-game name"
                            onChange={(event) => setItemName(event.target.value)}
                        />
                    </FormField>
                    <FormField label="Unit price" className={styles.PriceField}>
                        <input
                            type="number"
                            min="0"
                            step="1"
                            max={Number.MAX_SAFE_INTEGER}
                            required
                            value={unitPrice}
                            disabled={disabled}
                            onChange={(event) => setUnitPrice(event.target.value)}
                        />
                    </FormField>
                    <button type="submit" className="button" disabled={disabled}>
                        Add item
                    </button>
                </form>
                {error?.list === "general" && <Feedback tone="error">{error.message}</Feedback>}
            </div>
        </>
    );
}
