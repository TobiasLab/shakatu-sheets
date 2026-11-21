import { type KeyboardEvent, useState } from "react";
import { type HeatmapCell, type HistoryAnalytics, weeklyHeatmap } from "../../domain/analytics";
import { formatSignedSilver } from "../../format";
import styles from "./HistoryAnalytics.module.css";

export type HeatmapView = "time" | "rate";

const HOUR_MS = 3_600_000;
// A few minutes in an hour give a wild rate, so the Net / hour view shades only hours with at least this much time.
const MIN_RATE_MS = 30 * 60_000;

const weekdayFormatter = new Intl.DateTimeFormat("en", { weekday: "short" });
// 1 January 2024 was a Monday, so day d of the week is 1 + d January 2024.
const WEEKDAYS = Array.from({ length: 7 }, (_, day) => weekdayFormatter.format(new Date(2024, 0, 1 + day)));
const hoursFormatter = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function hourSpan(hour: number) {
    return `${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`;
}

function rate(cell: HeatmapCell) {
    return cell.trackedMs >= MIN_RATE_MS ? (cell.net * HOUR_MS) / cell.trackedMs : null;
}

function describe(day: number, hour: number, cell: HeatmapCell) {
    const hours = `${hoursFormatter.format(cell.trackedMs / HOUR_MS)} h`;
    const perHour = cell.trackedMs > 0 ? ` · ${formatSignedSilver((cell.net * HOUR_MS) / cell.trackedMs)}/h` : "";
    return `${WEEKDAYS[day]} ${hourSpan(hour)} · ${hours}${perHour}`;
}

// When grinding happens across the week (local time) and how well each hour pays, shaded in one hue.
export function Heatmap({
    analytics,
    view,
    onViewChange,
}: {
    analytics: HistoryAnalytics;
    view: HeatmapView;
    onViewChange: (view: HeatmapView) => void;
}) {
    const [active, setActive] = useState<{ day: number; hour: number } | null>(null);
    const cells = weeklyHeatmap(analytics);
    const value = (cell: HeatmapCell) => (view === "time" ? (cell.trackedMs > 0 ? cell.trackedMs : null) : rate(cell));
    type Top = { day: number; hour: number; value: number };
    const topBy = (measure: (cell: HeatmapCell) => number | null) => {
        let top: Top | null = null;
        cells.forEach((row, day) => {
            row.forEach((cell, hour) => {
                const shown = measure(cell);
                if (shown !== null && (top === null || shown > top.value)) top = { day, hour, value: shown };
            });
        });
        return top as Top | null;
    };
    const busiest = topBy((cell) => (cell.trackedMs > 0 ? cell.trackedMs : null));
    if (busiest === null) return null;
    // The Net / hour view can have no hour with enough time; the section and its switch stay so Time is one click away.
    const best = view === "time" ? busiest : topBy(rate);
    const shade = (cell: HeatmapCell) => {
        const shown = value(cell);
        if (shown === null || best === null) return undefined;
        const share = best.value > 0 ? Math.max(0, shown) / best.value : 0;
        return `color-mix(in srgb, var(--gold) ${Math.round(14 + share * 86)}%, var(--surface))`;
    };
    const activeCell = active ? cells[active.day][active.hour] : null;
    const headline =
        best === null
            ? "No hour has 30 minutes tracked yet"
            : view === "time"
              ? `Most time ${WEEKDAYS[best.day]} ${hourSpan(best.hour)} · ${hoursFormatter.format(best.value / HOUR_MS)} h`
              : `Best ${WEEKDAYS[best.day]} ${hourSpan(best.hour)} · ${formatSignedSilver(best.value)}/h`;
    const start = best ?? busiest;

    function step(event: KeyboardEvent<HTMLDivElement>) {
        const moves: Record<string, [number, number]> = {
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
        };
        if (event.key === "Escape") setActive(null);
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        // The first arrow press shows the busiest (or best paying) hour; later presses move from the one shown.
        setActive((current) =>
            current === null
                ? { day: start.day, hour: start.hour }
                : {
                      day: Math.min(6, Math.max(0, current.day + move[0])),
                      hour: Math.min(23, Math.max(0, current.hour + move[1])),
                  },
        );
    }

    return (
        <figure className={styles.Chart} aria-label="Grinding by weekday and hour">
            <figcaption>
                <div className={styles.SectionHeading}>
                    <h2>Weekday and hour</h2>
                    <fieldset className="segmented">
                        <legend className="sr-only">Shade by</legend>
                        {(["time", "rate"] as const).map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={view === option}
                                onClick={() => onViewChange(option)}
                            >
                                {option === "time" ? "Time" : "Net / hour"}
                            </button>
                        ))}
                    </fieldset>
                </div>
                <span>{active && activeCell ? describe(active.day, active.hour, activeCell) : headline}</span>
            </figcaption>
            <div
                className={styles.Heatmap}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={`Tracked time and net per hour by local weekday and hour. ${headline}`}
                onKeyDown={step}
                onBlur={() => setActive(null)}
                onPointerLeave={() => setActive(null)}
            >
                <span aria-hidden="true" />
                {Array.from({ length: 24 }, (_, hour) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: The hours of a day are a fixed 24.
                    <span key={hour} className={styles.HeatmapHour} aria-hidden="true">
                        {hour % 3 === 0 ? hour : ""}
                    </span>
                ))}
                {cells.map((row, day) => [
                    <span key={`label-${WEEKDAYS[day]}`} className={styles.HeatmapDay} aria-hidden="true">
                        {WEEKDAYS[day]}
                    </span>,
                    ...row.map((cell, hour) => (
                        <i
                            // biome-ignore lint/suspicious/noArrayIndexKey: The grid is a fixed 7 by 24.
                            key={hour}
                            className={styles.HeatmapCell}
                            data-hours={cell.trackedMs > 0 || undefined}
                            data-active={(active?.day === day && active.hour === hour) || undefined}
                            style={{ background: shade(cell) }}
                            onPointerEnter={() => setActive({ day, hour })}
                        />
                    )),
                ])}
            </div>
            <div className={styles.HeatmapLegend} aria-hidden="true">
                <span>Less</span>
                {[14, 36, 57, 79, 100].map((share) => (
                    <i
                        key={share}
                        style={{ background: `color-mix(in srgb, var(--gold) ${share}%, var(--surface))` }}
                    />
                ))}
                <span>More</span>
            </div>
            {/* The arrow-key readout is only visual in the caption, so screen readers hear it here. */}
            <span className="sr-only" aria-live="polite">
                {active && activeCell ? describe(active.day, active.hour, activeCell) : ""}
            </span>
        </figure>
    );
}
