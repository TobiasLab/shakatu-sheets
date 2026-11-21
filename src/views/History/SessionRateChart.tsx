import { type KeyboardEvent, memo, type PointerEvent, useState } from "react";
import { grindSpotName } from "../../data/grindSpots";
import { formatSignedSilver, formatTimestamp } from "../../format";
import styles from "./HistoryAnalytics.module.css";

type SessionRate = { id: string; grindSpotId: string; finishedAt: number; rate: number };
// Time runs from the first session's completion over `span`; rates run from `low` to `high`. Both map to percentages.
type Scale = { first: number; span: number; low: number; high: number };

function left(finishedAt: number, { first, span }: Scale) {
    return span > 0 ? ((finishedAt - first) / span) * 100 : 50;
}

function top(rate: number, { low, high }: Scale) {
    return 100 - ((rate - low) / (high - low)) * 100;
}

// History can hold thousands of sessions, so the dots render once and a pointer move redraws only the active one.
const Dots = memo(function Dots({ points, first, span, low, high }: { points: SessionRate[] } & Scale) {
    const scale = { first, span, low, high };
    return points.map((point) => (
        <i
            key={point.id}
            className={styles.Dot}
            style={{ left: `${left(point.finishedAt, scale)}%`, top: `${top(point.rate, scale)}%` }}
        />
    ));
});

// One dot per session at its completion time, against a hairline at the average of all of them.
export function SessionRateChart({
    points,
    average,
    showSpot,
}: {
    points: SessionRate[];
    average: number;
    showSpot: boolean;
}) {
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    if (points.length === 0) return null;

    const first = points[0].finishedAt;
    // A loop rather than spreading every rate into Math.min, which has an argument limit.
    let lowest = points[0].rate;
    let highest = points[0].rate;
    for (const point of points) {
        lowest = Math.min(lowest, point.rate);
        highest = Math.max(highest, point.rate);
    }
    const scale = {
        first,
        span: points[points.length - 1].finishedAt - first,
        low: Math.min(0, lowest),
        high: Math.max(1, highest),
    };
    const x = (finishedAt: number) => left(finishedAt, scale);
    const y = (rate: number) => top(rate, scale);
    const active = activeIndex === null ? null : points[activeIndex];
    const describe = (point: SessionRate) =>
        `${formatSignedSilver(point.rate)}/h, ${showSpot ? `${grindSpotName(point.grindSpotId)}, ` : ""}${formatTimestamp(point.finishedAt)}`;
    const summary = `Net per hour of ${points.length} ${points.length === 1 ? "session" : "sessions"} from ${formatTimestamp(first)} to ${formatTimestamp(points[points.length - 1].finishedAt)}, average ${formatSignedSilver(average)} per hour, lowest ${formatSignedSilver(lowest)}, highest ${formatSignedSilver(highest)}`;

    function step(event: KeyboardEvent<HTMLDivElement>) {
        const last = points.length - 1;
        // The first arrow press shows the newest session; later presses step from the one shown.
        const next =
            (event.key === "ArrowLeft" || event.key === "ArrowRight") && activeIndex === null
                ? last
                : event.key === "ArrowLeft"
                  ? Math.max(0, (activeIndex ?? last) - 1)
                  : event.key === "ArrowRight"
                    ? Math.min(last, (activeIndex ?? last) + 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : null;
        if (event.key === "Escape") setActiveIndex(null);
        if (next === null) return;
        event.preventDefault();
        setActiveIndex(next);
    }

    // The nearest dot on screen follows the pointer, so a small dot is easy to reach.
    function track(event: PointerEvent<HTMLDivElement>) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const pointerX = ((event.clientX - bounds.left) / bounds.width) * 100;
        const pointerY = ((event.clientY - bounds.top) / bounds.height) * 100;
        let nearest = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;
        points.forEach((point, index) => {
            const dx = ((x(point.finishedAt) - pointerX) * bounds.width) / 100;
            const dy = ((y(point.rate) - pointerY) * bounds.height) / 100;
            const distance = dx * dx + dy * dy;
            if (distance < nearestDistance) {
                nearest = index;
                nearestDistance = distance;
            }
        });
        setActiveIndex(nearest);
    }

    return (
        <figure className={styles.Chart} aria-label="Net per hour by session">
            <figcaption>
                <h2>Net / hour by session</h2>
                {active ? (
                    <span>
                        <strong>{formatSignedSilver(active.rate)}/h</strong>{" "}
                        {showSpot && `${grindSpotName(active.grindSpotId)} · `}
                        {formatTimestamp(active.finishedAt)}
                    </span>
                ) : (
                    <span>
                        Average <strong>{formatSignedSilver(average)}/h</strong>
                    </span>
                )}
            </figcaption>
            <div
                className={styles.Plot}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={summary}
                onPointerMove={track}
                onPointerLeave={() => setActiveIndex(null)}
                onKeyDown={step}
                onBlur={() => setActiveIndex(null)}
            >
                <i className={styles.Zero} style={{ top: `${y(0)}%` }} />
                <i className={styles.Average} style={{ top: `${y(average)}%` }} />
                <Dots points={points} {...scale} />
                {active && (
                    <i
                        className={styles.Dot}
                        data-active
                        style={{ left: `${x(active.finishedAt)}%`, top: `${y(active.rate)}%` }}
                    />
                )}
            </div>
            {/* The arrow-key readout is only visual in the caption, so screen readers hear it here. */}
            <span className="sr-only" aria-live="polite">
                {active ? describe(active) : ""}
            </span>
        </figure>
    );
}
