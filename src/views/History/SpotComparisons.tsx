import { grindSpotName } from "../../data/grindSpots";
import { netPerHour, type SpotSummary } from "../../domain/history";
import { formatDuration, formatSilver } from "../../format";
import styles from "./History.module.css";

export function SpotComparisons({
    spots,
    selectedSpotId,
    disabled,
    onSelect,
}: {
    spots: SpotSummary[];
    selectedSpotId: string;
    disabled: boolean;
    onSelect: (id: string) => void;
}) {
    const bestRate = Math.max(0, ...spots.map((spot) => netPerHour(spot) ?? 0));
    return (
        <section className={styles.Comparisons} aria-label="Grind spot comparisons">
            <div className={styles.ComparisonHeading}>
                <h2>Grind spot comparisons</h2>
                <span>
                    {spots.length} {spots.length === 1 ? "spot" : "spots"}
                </span>
            </div>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard access. */}
            <section className={styles.ComparisonScroll} aria-label="Spot earnings table" tabIndex={0}>
                <table>
                    <thead>
                        <tr>
                            <th scope="col">Grind spot</th>
                            <th scope="col">Net / hour</th>
                            <th scope="col">Sessions</th>
                            <th scope="col">Time tracked</th>
                            <th scope="col">Recorded net</th>
                        </tr>
                    </thead>
                    <tbody>
                        {spots.map((spot) => {
                            const rate = netPerHour(spot);
                            return (
                                <tr key={spot.grindSpotId} data-selected={selectedSpotId === spot.grindSpotId}>
                                    <th scope="row">
                                        <button
                                            type="button"
                                            className="button subtle"
                                            aria-pressed={selectedSpotId === spot.grindSpotId}
                                            disabled={disabled}
                                            onClick={() => onSelect(spot.grindSpotId)}
                                        >
                                            {grindSpotName(spot.grindSpotId)}
                                        </button>
                                    </th>
                                    <td>
                                        <span className={styles.Rate}>
                                            {rate !== null && rate > 0 && bestRate > 0 && (
                                                <i
                                                    aria-hidden="true"
                                                    style={{ width: `${(rate / bestRate) * 100}%` }}
                                                />
                                            )}
                                            {rate === null ? "—" : `${formatSilver(rate, true)}/h`}
                                        </span>
                                    </td>
                                    <td>
                                        {spot.sessionCount}
                                        {spot.zeroDurationCount > 0 && (
                                            <small>{spot.sessionCount - spot.zeroDurationCount} timed</small>
                                        )}
                                    </td>
                                    <td>{formatDuration(spot.elapsedMs)}</td>
                                    <td>{formatSilver(spot.net, true)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </section>
        </section>
    );
}
