import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { PACING_STRETCH_MS, pacingStretches, type SessionPacing } from "../../domain/analytics";
import { formatSignedSilver } from "../../format";
import styles from "./HistoryAnalytics.module.css";

// Below this many sessions a stretch's average is mostly one session's luck, so its bar is faded.
const FEW_SESSIONS = 3;

function clock(milliseconds: number) {
    const minutes = Math.round(milliseconds / 60_000);
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function sessions(count: number) {
    return `${count} ${count === 1 ? "session" : "sessions"}`;
}

// One bar per quarter hour into a session: the net per hour earned in it, averaged over the sessions that lasted
// through it, against a hairline at the average of every measured quarter hour.
export function PacingChart({ pacing }: { pacing: SessionPacing[] }) {
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    const stretches = pacingStretches(pacing);
    if (stretches.length === 0) return null;

    let low = 0;
    let high = 1;
    let earned = 0;
    let measured = 0;
    for (const stretch of stretches) {
        low = Math.min(low, stretch.rate);
        high = Math.max(high, stretch.rate);
        earned += stretch.rate * stretch.sessionCount;
        measured += stretch.sessionCount;
    }
    const average = earned / measured;
    const y = (rate: number) => 100 - ((rate - low) / (high - low)) * 100;
    const width = 100 / stretches.length;
    const active = activeIndex === null ? null : stretches[activeIndex];
    const span = (startMs: number) => `${clock(startMs)}–${clock(startMs + PACING_STRETCH_MS)}`;
    const last = stretches[stretches.length - 1];
    const summary = `Net per hour in each quarter hour of a session, over ${sessions(pacing.length)}: ${formatSignedSilver(stretches[0].rate)} per hour in the first, ${formatSignedSilver(last.rate)} per hour in the last (${span(last.startMs)}), average ${formatSignedSilver(average)} per hour`;

    function step(event: KeyboardEvent<HTMLDivElement>) {
        const end = stretches.length - 1;
        const next =
            event.key === "ArrowLeft"
                ? activeIndex === null
                    ? end
                    : Math.max(0, activeIndex - 1)
                : event.key === "ArrowRight"
                  ? activeIndex === null
                      ? 0
                      : Math.min(end, activeIndex + 1)
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

    function track(event: PointerEvent<HTMLDivElement>) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - bounds.left) / bounds.width;
        setActiveIndex(Math.min(stretches.length - 1, Math.max(0, Math.floor(ratio * stretches.length))));
    }

    return (
        <figure className={styles.Chart} aria-label="Net per hour through a session">
            <figcaption>
                <h2>Net / hour through a session</h2>
                {active ? (
                    <span>
                        <strong>{formatSignedSilver(active.rate)}/h</strong> {span(active.startMs)} ·{" "}
                        {sessions(active.sessionCount)}
                    </span>
                ) : (
                    <span>
                        Average <strong>{formatSignedSilver(average)}/h</strong>
                    </span>
                )}
            </figcaption>
            <div
                className={`${styles.Plot} ${styles.BarPlot}`}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={summary}
                onPointerMove={track}
                onPointerLeave={() => setActiveIndex(null)}
                onKeyDown={step}
                onBlur={() => setActiveIndex(null)}
            >
                {stretches.map((stretch, index) => {
                    const top = Math.min(y(stretch.rate), y(0));
                    return (
                        <i
                            key={stretch.startMs}
                            className={styles.Bar}
                            data-few={stretch.sessionCount < FEW_SESSIONS || undefined}
                            data-negative={stretch.rate < 0 || undefined}
                            data-active={index === activeIndex || undefined}
                            style={{
                                left: `${(index + 0.5) * width}%`,
                                width: `min(calc(${width}% - 2px), 40px)`,
                                top: `${top}%`,
                                height: `${Math.abs(y(stretch.rate) - y(0))}%`,
                            }}
                        />
                    );
                })}
                <i className={styles.Zero} style={{ top: `${y(0)}%` }} />
                <i className={styles.Average} style={{ top: `${y(average)}%` }} />
            </div>
            <div className={styles.HourAxis} aria-hidden="true">
                {stretches
                    .filter((stretch) => stretch.startMs % 3_600_000 === 0)
                    .map((stretch) => (
                        <span
                            key={stretch.startMs}
                            style={{ left: `${(stretch.startMs / PACING_STRETCH_MS) * width}%` }}
                        >
                            {clock(stretch.startMs)}
                        </span>
                    ))}
            </div>
            {/* The arrow-key readout is only visual in the caption, so screen readers hear it here. */}
            <span className="sr-only" aria-live="polite">
                {active
                    ? `${formatSignedSilver(active.rate)} per hour from ${span(active.startMs)}, ${sessions(active.sessionCount)}`
                    : ""}
            </span>
        </figure>
    );
}
