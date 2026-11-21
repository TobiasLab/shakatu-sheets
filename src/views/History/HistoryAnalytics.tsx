import { memo } from "react";
import { getDropIcon } from "../../data/grindSpots";
import { analyticsSummary, type HistoryAnalytics, itemRates, sessionRates } from "../../domain/analytics";
import { formatSilver } from "../../format";
import styles from "./HistoryAnalytics.module.css";
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
}: {
    analytics: HistoryAnalytics;
    grindSpotId: string | null;
}) {
    const summary = analyticsSummary(analytics);
    const points = sessionRates(analytics);
    const items = grindSpotId === null ? [] : itemRates(analytics);
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
            </div>
            <SessionRateChart
                points={points}
                average={(summary.baseRate ?? 0) + (summary.rareRate ?? 0)}
                showSpot={grindSpotId === null}
            />
            {grindSpotId === null ? (
                <p className={styles.Hint}>Choose a grind spot to see its items.</p>
            ) : (
                <>
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
                                                    <td>{shareFormatter.format(item.share)}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </section>
                        </section>
                    )}
                    <RareDrops analytics={analytics} grindSpotId={grindSpotId} />
                </>
            )}
        </section>
    );
});
