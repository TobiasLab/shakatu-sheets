import type { Dispatch, SetStateAction } from "react";
import { getGrindSpotDrops } from "../../data/grindSpots";
import { type PriceImport, priceHistory } from "../../domain/analytics";
import { formatRelativeDay, formatSilver } from "../../format";
import { type ClosedSections, Collapsible } from "./Collapsible";
import styles from "./HistoryAnalytics.module.css";

const changeFormatter = new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
});

// Expenses and negative values use a true minus.
export function formatChange(change: number) {
    return changeFormatter.format(change).replace("-", "−");
}

// The spot's market items with at least one imported price: each one's price over time on a time axis all rows share,
// its latest price, its change since its first import, and when it was last imported.
export function MarketPrices({
    grindSpotId,
    imports,
    closed,
    onClosedChange,
}: {
    grindSpotId: string;
    imports: PriceImport[];
    closed: ClosedSections;
    onClosedChange: Dispatch<SetStateAction<ClosedSections>>;
}) {
    const history = priceHistory(imports);
    const seen = new Set<number>();
    const rows = getGrindSpotDrops(grindSpotId).flatMap((drop) => {
        const itemId = drop.marketItemId;
        const prices = itemId === undefined ? undefined : history.get(itemId);
        if (itemId === undefined || !prices || seen.has(itemId)) return [];
        seen.add(itemId);
        return [{ itemId, name: drop.name, icon: drop.icon, ...prices }];
    });
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.latest.basePrice - a.latest.basePrice || a.name.localeCompare(b.name));
    let first = rows[0].points[0].fetchedAt;
    let last = first;
    for (const row of rows) {
        for (const point of row.points) {
            first = Math.min(first, point.fetchedAt);
            last = Math.max(last, point.fetchedAt);
        }
    }
    const x = (fetchedAt: number) => (last > first ? ((fetchedAt - first) / (last - first)) * 100 : 100);
    return (
        <Collapsible section="market-prices" title="Market prices" closed={closed} onClosedChange={onClosedChange}>
            <section
                className={`${styles.ItemScroll} ${styles.PriceTable}`}
                aria-label="Imported market prices"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access.
                tabIndex={0}
            >
                <table>
                    <thead>
                        <tr>
                            <th scope="col">Item</th>
                            <th scope="col">Over time</th>
                            <th scope="col">Latest</th>
                            <th scope="col">Change</th>
                            <th scope="col">Imports</th>
                            <th scope="col">Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => {
                            // Each row scales its own prices, so its line shows its own movement.
                            let low = row.points[0].basePrice;
                            let high = low;
                            for (const point of row.points) {
                                low = Math.min(low, point.basePrice);
                                high = Math.max(high, point.basePrice);
                            }
                            const y = (price: number) => (high > low ? 100 - ((price - low) / (high - low)) * 100 : 50);
                            const line = row.points
                                .map((point) => `${x(point.fetchedAt)},${y(point.basePrice)}`)
                                .join(" ");
                            return (
                                <tr key={row.itemId}>
                                    <th scope="row">
                                        <span className={styles.ItemName}>
                                            <img src={row.icon} alt="" />
                                            {row.name}
                                        </span>
                                    </th>
                                    <td>
                                        <span className={styles.Sparkline} aria-hidden="true">
                                            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                                                <polyline points={line} />
                                            </svg>
                                            <i
                                                style={{
                                                    left: `${x(row.latest.fetchedAt)}%`,
                                                    top: `${y(row.latest.basePrice)}%`,
                                                }}
                                            />
                                        </span>
                                    </td>
                                    <td>{formatSilver(row.latest.basePrice, true)}</td>
                                    <td>{row.change === null ? "—" : formatChange(row.change)}</td>
                                    <td>{row.points.length}</td>
                                    <td>{formatRelativeDay(row.latest.fetchedAt)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </section>
        </Collapsible>
    );
}
