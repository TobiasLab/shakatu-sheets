import { useId } from "react";
import { chooseBuff, dropAmount, garmothBuffs } from "../../garmoth";
import styles from "./GarmothBuffPicker.module.css";

const lootScrolls = garmothBuffs.filter((buff) => buff.group === "loot-scroll");
const otherBuffs = garmothBuffs.filter((buff) => buff.group !== "loot-scroll");

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
                <span className={styles.Amount}>
                    Drop amount <strong>+{dropAmount(selected)}%</strong>
                </span>
            </div>
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
            <div className={styles.Grid}>
                {otherBuffs.map((buff) => {
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
