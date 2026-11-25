import { useId } from "react";
import { FormField } from "../../components/FormField/FormField";
import { chooseBuff, dropAmount, dropRate, garmothBuffs } from "../../garmoth";
import styles from "./GarmothBuffPicker.module.css";

const lootScrolls = garmothBuffs.filter((buff) => buff.group === "loot-scroll");
// Only one tier of these buffs can be active, so each is a single menu.
const tieredBuffs = [
    { group: "adventurers-luck", label: "[Camp] Adventurer's Luck" },
    { group: "node-war-benefit", label: "Node War Benefit" },
    { group: "fortuna", label: "Fortuna" },
].map((tiers) => ({ ...tiers, buffs: garmothBuffs.filter((buff) => buff.group === tiers.group) }));
const singleBuffs = garmothBuffs.filter((buff) => buff.group === null);

export function GarmothBuffPicker({
    selected,
    disabled,
    onChange,
}: {
    selected: number[];
    disabled: boolean;
    onChange: (selected: number[]) => void;
}) {
    const headingId = useId();
    const scrollLabelId = useId();
    const scroll = lootScrolls.find((buff) => selected.includes(buff.id));
    return (
        <section className={styles.Buffs} aria-labelledby={headingId}>
            <div className="panel-heading">
                <h2 id={headingId}>Drop buffs</h2>
                <dl className={styles.Totals}>
                    <div>
                        <dt>Drop amount</dt>
                        <dd>+{dropAmount(selected)}%</dd>
                    </div>
                    <div>
                        <dt>Drop rate</dt>
                        <dd>+{dropRate(selected)}%</dd>
                    </div>
                </dl>
            </div>
            <div className={styles.Tiers}>
                <div className={styles.Scroll}>
                    <span id={scrollLabelId}>Loot scroll</span>
                    <fieldset className="segmented" aria-labelledby={scrollLabelId} disabled={disabled}>
                        <button
                            type="button"
                            aria-pressed={!scroll}
                            onClick={() => scroll && onChange(chooseBuff(selected, scroll, false))}
                        >
                            None
                        </button>
                        {lootScrolls.map((buff) => (
                            <button
                                key={buff.id}
                                type="button"
                                aria-pressed={scroll?.id === buff.id}
                                onClick={() => onChange(chooseBuff(selected, buff, true))}
                            >
                                {buff.name}
                            </button>
                        ))}
                    </fieldset>
                </div>
                {tieredBuffs.map(({ group, label, buffs }) => {
                    const current = buffs.find((buff) => selected.includes(buff.id));
                    return (
                        <FormField key={group} label={label}>
                            <select
                                value={current?.id ?? ""}
                                disabled={disabled}
                                onChange={(event) => {
                                    const next = buffs.find((buff) => buff.id === Number(event.target.value));
                                    if (next) onChange(chooseBuff(selected, next, true));
                                    else if (current) onChange(chooseBuff(selected, current, false));
                                }}
                            >
                                <option value="">None</option>
                                {buffs.map((buff) => (
                                    <option key={buff.id} value={buff.id}>
                                        {buff.name.startsWith(label) ? buff.name.slice(label.length).trim() : buff.name}
                                    </option>
                                ))}
                            </select>
                        </FormField>
                    );
                })}
            </div>
            <div className={styles.Grid}>
                {singleBuffs.map((buff) => {
                    const chosen = selected.includes(buff.id);
                    return (
                        <button
                            key={buff.id}
                            type="button"
                            className={styles.Buff}
                            aria-pressed={chosen}
                            disabled={disabled}
                            onClick={() => onChange(chooseBuff(selected, buff, !chosen))}
                        >
                            {buff.icon ? (
                                <img src={buff.icon} alt="" width={28} height={28} />
                            ) : (
                                <span className={styles.NoIcon} />
                            )}
                            <span>{buff.name}</span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
