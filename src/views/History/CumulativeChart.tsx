import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { grindSpotName } from "../../data/grindSpots";
import { formatSignedSilver, formatTimestamp } from "../../format";
import styles from "./HistoryAnalytics.module.css";

type CumulativePoint = { id: string; grindSpotId: string; finishedAt: number; net: number };

// Recorded net added up over completion time: one line over a 10% wash, its latest point marked.
export function CumulativeChart({ points, showSpot }: { points: CumulativePoint[]; showSpot: boolean }) {
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    if (points.length < 2) return null;

    const first = points[0].finishedAt;
    const last = points[points.length - 1];
    const span = last.finishedAt - first;
    let low = 0;
    let high = 1;
    for (const point of points) {
        low = Math.min(low, point.net);
        high = Math.max(high, point.net);
    }
    const x = (finishedAt: number) => (span > 0 ? ((finishedAt - first) / span) * 100 : 100);
    const y = (net: number) => 100 - ((net - low) / (high - low)) * 100;
    const line = points.map((point) => `${x(point.finishedAt)},${y(point.net)}`).join(" ");
    const area = `0,${y(0)} ${line} 100,${y(0)}`;
    const active = activeIndex === null ? null : points[activeIndex];
    const shown = active ?? last;
    const where = (point: CumulativePoint) =>
        `${showSpot ? `${grindSpotName(point.grindSpotId)} · ` : ""}${formatTimestamp(point.finishedAt)}`;
    const summary = `Recorded net over ${points.length} sessions from ${formatTimestamp(first)} to ${formatTimestamp(last.finishedAt)}, reaching ${formatSignedSilver(last.net)}`;

    function step(event: KeyboardEvent<HTMLDivElement>) {
        const end = points.length - 1;
        // The first arrow press shows the newest session; later presses step from the one shown.
        const next =
            (event.key === "ArrowLeft" || event.key === "ArrowRight") && activeIndex === null
                ? end
                : event.key === "ArrowLeft"
                  ? Math.max(0, (activeIndex ?? end) - 1)
                  : event.key === "ArrowRight"
                    ? Math.min(end, (activeIndex ?? end) + 1)
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? end
                        : null;
        if (event.key === "Escape") setActiveIndex(null);
        if (next === null) return;
        event.preventDefault();
        setActiveIndex(next);
    }

    // The session completed nearest the pointer's time, found by halving the sorted list.
    function track(event: PointerEvent<HTMLDivElement>) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const at = first + ((event.clientX - bounds.left) / bounds.width) * span;
        let lowIndex = 0;
        let highIndex = points.length - 1;
        while (lowIndex < highIndex) {
            const middle = Math.floor((lowIndex + highIndex) / 2);
            if (points[middle].finishedAt < at) lowIndex = middle + 1;
            else highIndex = middle;
        }
        const before = Math.max(0, lowIndex - 1);
        setActiveIndex(
            Math.abs(points[before].finishedAt - at) <= Math.abs(points[lowIndex].finishedAt - at) ? before : lowIndex,
        );
    }

    return (
        <figure className={styles.Chart} aria-label="Recorded net over time">
            <figcaption>
                <h2>Recorded net over time</h2>
                {active ? (
                    <span>
                        <strong>{formatSignedSilver(active.net)}</strong> after {where(active)}
                    </span>
                ) : (
                    <span>
                        Total <strong>{formatSignedSilver(last.net)}</strong>
                    </span>
                )}
            </figcaption>
            <div
                className={`${styles.Plot} ${styles.LinePlot}`}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={summary}
                onPointerMove={track}
                onPointerLeave={() => setActiveIndex(null)}
                onKeyDown={step}
                onBlur={() => setActiveIndex(null)}
            >
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    {low < 0 && <line className={styles.LineZero} x1="0" x2="100" y1={y(0)} y2={y(0)} />}
                    <polygon className={styles.LineArea} points={area} />
                    <polyline className={styles.Line} points={line} />
                </svg>
                {active && <i className={styles.Crosshair} style={{ left: `${x(active.finishedAt)}%` }} />}
                <i className={styles.EndDot} style={{ left: `${x(shown.finishedAt)}%`, top: `${y(shown.net)}%` }} />
            </div>
            {/* The arrow-key readout is only visual in the caption, so screen readers hear it here. */}
            <span className="sr-only" aria-live="polite">
                {active ? `${formatSignedSilver(active.net)} after ${where(active)}` : ""}
            </span>
        </figure>
    );
}
