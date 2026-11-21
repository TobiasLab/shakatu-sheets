import { grindSpotName } from "../../data/grindSpots";
import { type ConsistencyView, type HistoryAnalytics, spotConsistency } from "../../domain/analytics";
import { formatSignedSilver } from "../../format";
import styles from "./HistoryAnalytics.module.css";

// Below this many timed sessions a spot's spread says little about its next session.
const FEW_SESSIONS = 5;

function range(low: number, high: number) {
    return `${formatSignedSilver(low)}–${formatSignedSilver(high)}/h`;
}

export function Consistency({
    analytics,
    view,
    onViewChange,
}: {
    analytics: HistoryAnalytics;
    view: ConsistencyView;
    onViewChange: (view: ConsistencyView) => void;
}) {
    const spots = spotConsistency(analytics, view);
    if (spots.length === 0) return null;
    // Every row shares one scale, from the lowest to the highest session, so spots compare by position as well as by
    // number. A box plot needs no zero baseline, and starting at zero would squeeze every box to one side.
    let low = spots[0].spread.min;
    let high = spots[0].spread.max;
    for (const { spread } of spots) {
        low = Math.min(low, spread.min);
        high = Math.max(high, spread.max);
    }
    const span = high > low ? high - low : 1;
    const at = (value: number) => ((value - low) / span) * 100;
    return (
        <section className={styles.Items} aria-label="Consistency">
            <div className={styles.SectionHeading}>
                <h2>Net / hour per session</h2>
                <fieldset className="segmented">
                    <legend className="sr-only">Net</legend>
                    {(["total", "base"] as const).map((option) => (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={view === option}
                            onClick={() => onViewChange(option)}
                        >
                            {option === "total" ? "Total" : "Base"}
                        </button>
                    ))}
                </fieldset>
            </div>
            <section
                className={`${styles.ItemScroll} ${styles.SpreadTable}`}
                aria-label="Net per hour spread by spot"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access.
                tabIndex={0}
            >
                <table>
                    <thead>
                        <tr>
                            <th scope="col">Grind spot</th>
                            <th scope="col">Spread</th>
                            <th scope="col">Median</th>
                            <th scope="col">Middle half</th>
                            <th scope="col">Lowest–highest</th>
                            <th scope="col">Sessions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {spots.map(({ grindSpotId, sessionCount, spread }) => (
                            <tr key={grindSpotId}>
                                <th scope="row">
                                    <span className={styles.ItemName}>
                                        {grindSpotName(grindSpotId)}
                                        {sessionCount < FEW_SESSIONS && (
                                            <small className={styles.Tag}>Few sessions</small>
                                        )}
                                    </span>
                                </th>
                                <td>
                                    <span className={styles.Spread} aria-hidden="true">
                                        <i
                                            className={styles.Whisker}
                                            style={{
                                                left: `${at(spread.min)}%`,
                                                width: `${at(spread.max) - at(spread.min)}%`,
                                            }}
                                        />
                                        <i
                                            className={styles.Box}
                                            style={{
                                                left: `${at(spread.q1)}%`,
                                                width: `${at(spread.q3) - at(spread.q1)}%`,
                                            }}
                                        />
                                        <i className={styles.Median} style={{ left: `${at(spread.median)}%` }} />
                                    </span>
                                </td>
                                <td>{formatSignedSilver(spread.median)}/h</td>
                                <td>{range(spread.q1, spread.q3)}</td>
                                <td>{range(spread.min, spread.max)}</td>
                                <td>{sessionCount}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </section>
    );
}
