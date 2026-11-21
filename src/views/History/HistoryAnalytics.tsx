import { memo } from "react";
import { getDropIcon, getGrindSpotDrops } from "../../data/grindSpots";
import {
    analyticsSummary,
    type ConsistencyView,
    consumableCost,
    type HistoryAnalytics,
    itemRates,
    type PriceImport,
    priceHistory,
    sessionRates,
    todayValues,
} from "../../domain/analytics";
import { formatSilver } from "../../format";
import { Consistency } from "./Consistency";
import styles from "./HistoryAnalytics.module.css";
import { formatChange, MarketPrices } from "./MarketPrices";
import { PacingChart } from "./PacingChart";
import { RareDrops } from "./RareDrops";
import { SessionRateChart } from "./SessionRateChart";

const quantityRateFormatter = new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shareFormatter = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });

function silverRate(rate: number | null) {
    return rate === null ? "—" : `${formatSilver(rate, true)}/h`;
}

// History re-renders on every live-session save, while analytics change only with their read, so the panel (its
// chart, tables and log) skips those renders.
export const HistoryAnalyticsPanel = memo(function HistoryAnalyticsPanel({
    analytics,
    grindSpotId,
    prices,
    consistencyView,
    onConsistencyViewChange,
}: {
    analytics: HistoryAnalytics;
    grindSpotId: string | null;
    // Imported prices of the spot's market items in the filtered region; null without one spot and one region.
    prices: PriceImport[] | null;
    consistencyView: ConsistencyView;
    onConsistencyViewChange: (view: ConsistencyView) => void;
}) {
    const summary = analyticsSummary(analytics);
    const points = sessionRates(analytics);
    const items = grindSpotId === null ? [] : itemRates(analytics);
    const cost = consumableCost(analytics);
    const recordedRate = (summary.baseRate ?? 0) + (summary.rareRate ?? 0);
    let today: ReturnType<typeof todayValues> = null;
    if (grindSpotId !== null && prices !== null && prices.length > 0) {
        const marketItemIds = new Map<string, number>();
        for (const drop of getGrindSpotDrops(grindSpotId)) {
            if (drop.marketItemId !== undefined) marketItemIds.set(drop.name, drop.marketItemId);
        }
        const latest = new Map(
            [...priceHistory(prices)].map(([itemId, history]) => [itemId, history.latest.basePrice]),
        );
        today = todayValues(analytics, marketItemIds, latest);
        // Without loot that has a market price, today's values equal the recorded ones and add nothing.
        if (today?.pricedItems === 0) today = null;
    }
    if (points.length === 0) {
        return (
            <section className={styles.Analytics} aria-label="Analytics">
                <p className={styles.Hint}>No sessions with tracked time match these filters.</p>
            </section>
        );
    }
    return (
        <section className={styles.Analytics} aria-label="Analytics">
            <div className={styles.Readouts}>
                <div>
                    <span>Base silver / hour</span>
                    <strong>{silverRate(summary.baseRate)}</strong>
                </div>
                <div>
                    <span>Rare drops / hour</span>
                    <strong>{silverRate(summary.rareRate)}</strong>
                </div>
                <div>
                    <span>Rare share of loot</span>
                    <strong>{summary.rareShare === null ? "—" : shareFormatter.format(summary.rareShare)}</strong>
                </div>
                <div>
                    <span>Consumables / hour</span>
                    <strong data-negative={(cost.perHour ?? 0) > 0 || undefined}>
                        {cost.perHour === null
                            ? "—"
                            : `${cost.perHour > 0 ? "−" : ""}${formatSilver(Math.abs(cost.perHour), true)}/h`}
                    </strong>
                    {cost.shareOfLoot !== null && <small>{shareFormatter.format(cost.shareOfLoot)} of loot</small>}
                </div>
                {today && (
                    <div>
                        <span>Net / hour at today's prices</span>
                        <strong>{silverRate(today.netRate)}</strong>
                        {recordedRate > 0 && (
                            <small>{formatChange(today.netRate / recordedRate - 1)} vs recorded</small>
                        )}
                    </div>
                )}
            </div>
            <SessionRateChart
                points={points}
                average={(summary.baseRate ?? 0) + (summary.rareRate ?? 0)}
                showSpot={grindSpotId === null}
            />
            <Consistency analytics={analytics} view={consistencyView} onViewChange={onConsistencyViewChange} />
            {grindSpotId === null ? (
                <p className={styles.Hint}>Choose a grind spot to see its pacing and items.</p>
            ) : (
                <>
                    <PacingChart pacing={analytics.pacing} />
                    {items.length > 0 && (
                        <section className={styles.Items} aria-label="Items per hour">
                            <h2>Items per hour</h2>
                            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access. */}
                            <section className={styles.ItemScroll} aria-label="Item rates table" tabIndex={0}>
                                <table>
                                    <thead>
                                        <tr>
                                            <th scope="col">Item</th>
                                            <th scope="col">Per hour</th>
                                            <th scope="col">Session range</th>
                                            <th scope="col">Sessions</th>
                                            <th scope="col">Silver / hour</th>
                                            {today && <th scope="col">Today / hour</th>}
                                            <th scope="col">Share</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {items.map((item) => {
                                            const icon = getDropIcon(grindSpotId, item.name);
                                            return (
                                                <tr key={item.name}>
                                                    <th scope="row">
                                                        <span className={styles.ItemName}>
                                                            {icon ? (
                                                                <img src={icon} alt="" />
                                                            ) : (
                                                                <b aria-hidden="true" />
                                                            )}
                                                            {item.name}
                                                            {item.rare && <small className={styles.Tag}>Rare</small>}
                                                        </span>
                                                    </th>
                                                    <td>{quantityRateFormatter.format(item.perHour)}</td>
                                                    <td>
                                                        {quantityRateFormatter.format(item.lowRate)}–
                                                        {quantityRateFormatter.format(item.highRate)}
                                                    </td>
                                                    <td>
                                                        {item.sessionCount} / {item.timedSessionCount}
                                                    </td>
                                                    <td>{formatSilver(item.silverPerHour, true)}/h</td>
                                                    {today && (
                                                        <td>{silverRate(today.itemPerHour.get(item.name) ?? null)}</td>
                                                    )}
                                                    <td>{shareFormatter.format(item.share)}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </section>
                        </section>
                    )}
                    {prices && <MarketPrices grindSpotId={grindSpotId} imports={prices} />}
                    <RareDrops analytics={analytics} grindSpotId={grindSpotId} />
                </>
            )}
        </section>
    );
});
