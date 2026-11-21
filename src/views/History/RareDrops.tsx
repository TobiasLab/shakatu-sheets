import { type ReactNode, useMemo } from "react";
import { getDropIcon } from "../../data/grindSpots";
import { type HistoryAnalytics, rareDrops, rareItemStats } from "../../domain/analytics";
import { formatDuration, formatTimestamp } from "../../format";
import styles from "./HistoryAnalytics.module.css";

// Below this many drops an item's average gap says little about the next one.
const FEW_DROPS = 5;

const hoursFormatter = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const countFormatter = new Intl.NumberFormat("en");

function formatHours(milliseconds: number) {
    return `${hoursFormatter.format(milliseconds / 3_600_000)} h`;
}

function formatChance(chance: number) {
    return chance < 0.01 ? "<1%" : `${Math.round(chance * 100)}%`;
}

function ItemName({ grindSpotId, name, children }: { grindSpotId: string; name: string; children?: ReactNode }) {
    const icon = getDropIcon(grindSpotId, name);
    return (
        <span className={styles.ItemName}>
            {icon ? <img src={icon} alt="" /> : <b aria-hidden="true" />}
            {name}
            {children}
        </span>
    );
}

export function RareDrops({ analytics, grindSpotId }: { analytics: HistoryAnalytics; grindSpotId: string }) {
    // History re-renders on every live-session save, while the drops change only with the analytics read.
    const drops = useMemo(() => rareDrops(analytics), [analytics]);
    const stats = useMemo(() => rareItemStats(analytics, drops), [analytics, drops]);
    if (stats.length === 0) return null;
    return (
        <>
            <section className={styles.Items} aria-label="Rare drops">
                <h2>Rare drops</h2>
                <section
                    className={`${styles.ItemScroll} ${styles.RareTable}`}
                    aria-label="Rare drop rates"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access.
                    tabIndex={0}
                >
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">Item</th>
                                <th scope="col">Over tracked time</th>
                                <th scope="col">Drops</th>
                                <th scope="col">Average gap</th>
                                <th scope="col">Since last</th>
                                <th scope="col">Chance of a gap this long</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stats.map((item) => (
                                <tr key={item.name}>
                                    <th scope="row">
                                        <ItemName grindSpotId={grindSpotId} name={item.name}>
                                            {item.count < FEW_DROPS && <small className={styles.Tag}>Few drops</small>}
                                        </ItemName>
                                    </th>
                                    <td>
                                        <span className={styles.Timeline} aria-hidden="true">
                                            {item.positions.map((position, index) => (
                                                // biome-ignore lint/suspicious/noArrayIndexKey: Drops at one position are interchangeable.
                                                <i key={index} style={{ left: `${position * 100}%` }} />
                                            ))}
                                        </span>
                                    </td>
                                    <td>{countFormatter.format(item.count)}</td>
                                    <td>{formatHours(item.averageGapMs)}</td>
                                    <td>
                                        {item.sinceLastIsMinimum && "≥ "}
                                        {formatHours(item.sinceLastMs)}
                                    </td>
                                    <td>{formatChance(item.gapChance)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            </section>
            <section className={styles.Items} aria-label="Rare drop log">
                <h2>Rare drop log</h2>
                <section
                    className={`${styles.ItemScroll} ${styles.LogTable}`}
                    aria-label="Rare drops, newest first"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access.
                    tabIndex={0}
                >
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">Session completed</th>
                                <th scope="col">Item</th>
                                <th scope="col">Into session</th>
                                <th scope="col">Since previous</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...drops].reverse().map((drop) => (
                                <tr key={`${drop.sessionId}-${drop.name}-${drop.atMs}`}>
                                    <td>{formatTimestamp(drop.finishedAt)}</td>
                                    <th scope="row">
                                        <ItemName grindSpotId={grindSpotId} name={drop.name}>
                                            {drop.quantity > 1 && (
                                                <span className={styles.Quantity}>×{drop.quantity}</span>
                                            )}
                                        </ItemName>
                                    </th>
                                    <td>{drop.atMs === null ? "—" : formatDuration(drop.atMs)}</td>
                                    <td>
                                        {drop.sinceMs === null
                                            ? "First"
                                            : `${drop.approximate ? "≈ " : ""}${formatHours(drop.sinceMs)}`}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            </section>
        </>
    );
}
