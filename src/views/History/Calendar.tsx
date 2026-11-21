import { type KeyboardEvent, useState } from "react";
import { type DayTotal, dailyTotals, type HistoryAnalytics } from "../../domain/analytics";
import { formatSignedSilver } from "../../format";
import styles from "./HistoryAnalytics.module.css";

export type CalendarView = "time" | "net";

const HOUR_MS = 3_600_000;
// A year of months; earlier ones are reached by narrowing the dates.
const MAX_MONTHS = 12;

const dayFormatter = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" });
const monthFormatter = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });
const hoursFormatter = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
// Five steps of gold over the surface, as in the legend. Fixed steps let each carry a day number colour that keeps 4.5:1
// contrast in both themes (see the module CSS); a continuous blend would leave mid shades unreadable.
const LEVELS = [14, 36, 62, 81, 100];

function shade(level: number) {
    return `color-mix(in srgb, var(--gold) ${LEVELS[level]}%, var(--surface))`;
}

function describe(day: number, total: DayTotal | undefined) {
    const date = dayFormatter.format(day);
    if (!total) return `${date} · no sessions`;
    const parts = [date];
    if (total.trackedMs > 0) parts.push(`${hoursFormatter.format(total.trackedMs / HOUR_MS)} h`);
    parts.push(`${formatSignedSilver(total.net)} net`);
    if (total.trackedMs > 0) parts.push(`${formatSignedSilver((total.net * HOUR_MS) / total.trackedMs)}/h`);
    return parts.join(" · ");
}

// Month calendars of the filtered sessions in local time: every day shows its date, shaded in one gold scale by
// tracked time or net.
export function Calendar({
    analytics,
    view,
    onViewChange,
}: {
    analytics: HistoryAnalytics;
    view: CalendarView;
    onViewChange: (view: CalendarView) => void;
}) {
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    const totals = dailyTotals(analytics);
    if (totals.size === 0) return null;

    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const day of totals.keys()) {
        first = Math.min(first, day);
        last = Math.max(last, day);
    }
    const lastDate = new Date(last);
    const firstDate = new Date(first);
    const monthCount = Math.min(
        MAX_MONTHS,
        (lastDate.getFullYear() - firstDate.getFullYear()) * 12 + lastDate.getMonth() - firstDate.getMonth() + 1,
    );
    const clipped = new Date(lastDate.getFullYear(), lastDate.getMonth() - monthCount + 1, 1).getTime() > first;
    // Every day of the shown months in date order, so the arrow keys can walk across months.
    const days: { day: number; date: number; month: number; column: number }[] = [];
    const months = Array.from({ length: monthCount }, (_, month) => {
        const start = new Date(lastDate.getFullYear(), lastDate.getMonth() - monthCount + 1 + month, 1);
        const length = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
        for (let date = 1; date <= length; date++) {
            const day = new Date(start.getFullYear(), start.getMonth(), date);
            days.push({ day: day.getTime(), date, month, column: (day.getDay() + 6) % 7 });
        }
        return start.getTime();
    });

    const value = (total: DayTotal | undefined) =>
        !total ? null : view === "time" ? (total.trackedMs > 0 ? total.trackedMs : null) : total.net;
    let best: { index: number; value: number } | null = null;
    days.forEach(({ day }, index) => {
        const shown = value(totals.get(day));
        if (shown !== null && (best === null || shown > best.value)) best = { index, value: shown };
    });
    const top = best as { index: number; value: number } | null;
    const level = (total: DayTotal | undefined) => {
        const shown = value(total);
        if (shown === null || top === null) return null;
        const share = top.value > 0 ? Math.max(0, shown) / top.value : 0;
        return Math.min(LEVELS.length - 1, Math.floor(share * LEVELS.length));
    };
    const headline =
        top === null
            ? "No tracked time in these months"
            : view === "time"
              ? `Most time ${dayFormatter.format(days[top.index].day)} · ${hoursFormatter.format(top.value / HOUR_MS)} h`
              : `Best ${dayFormatter.format(days[top.index].day)} · ${formatSignedSilver(top.value)}`;
    const active = activeIndex === null ? null : days[activeIndex];

    function step(event: KeyboardEvent<HTMLDivElement>) {
        const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (event.key === "Escape") setActiveIndex(null);
        const move = moves[event.key];
        if (move === undefined) return;
        event.preventDefault();
        // The first arrow press shows the busiest (or best) day; later presses move by a day or a week.
        setActiveIndex((current) =>
            current === null ? (top?.index ?? days.length - 1) : Math.min(days.length - 1, Math.max(0, current + move)),
        );
    }

    return (
        <figure className={styles.Chart} aria-label="Grinding by day">
            <figcaption>
                <div className={styles.SectionHeading}>
                    <h2>Day by day</h2>
                    <fieldset className="segmented">
                        <legend className="sr-only">Shade by</legend>
                        {(["time", "net"] as const).map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={view === option}
                                onClick={() => onViewChange(option)}
                            >
                                {option === "time" ? "Time" : "Net"}
                            </button>
                        ))}
                    </fieldset>
                </div>
                <span>{active ? describe(active.day, totals.get(active.day)) : headline}</span>
            </figcaption>
            <div
                className={styles.Months}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={`Tracked time and net per day over ${monthCount} ${monthCount === 1 ? "month" : "months"}. ${headline}`}
                onKeyDown={step}
                onBlur={() => setActiveIndex(null)}
                onPointerLeave={() => setActiveIndex(null)}
            >
                {months.map((start, month) => (
                    <div key={start} className={styles.Month}>
                        <span className={styles.MonthName} aria-hidden="true">
                            {monthFormatter.format(start)}
                        </span>
                        <div className={styles.MonthGrid}>
                            {WEEKDAYS.map((weekday, column) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: A week's seven days are fixed.
                                <span key={column} className={styles.MonthWeekday} aria-hidden="true">
                                    {weekday}
                                </span>
                            ))}
                            {days.map((entry, index) => {
                                if (entry.month !== month) return null;
                                const total = totals.get(entry.day);
                                const step = level(total);
                                return (
                                    <span
                                        key={entry.day}
                                        className={styles.MonthDay}
                                        data-hours={(total && total.trackedMs > 0) || undefined}
                                        data-level={step ?? undefined}
                                        data-active={index === activeIndex || undefined}
                                        style={{
                                            gridColumn: entry.date === 1 ? entry.column + 1 : undefined,
                                            background: step === null ? undefined : shade(step),
                                        }}
                                        aria-hidden="true"
                                        onPointerEnter={() => setActiveIndex(index)}
                                    >
                                        {entry.date}
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
            <div className={styles.HeatmapLegend} aria-hidden="true">
                <span>Less</span>
                {LEVELS.map((percent, step) => (
                    <i key={percent} style={{ background: shade(step) }} />
                ))}
                <span>More</span>
                {clipped && <small>Last {MAX_MONTHS} months</small>}
            </div>
            {/* The arrow-key readout is only visual in the caption, so screen readers hear it here. */}
            <span className="sr-only" aria-live="polite">
                {active ? describe(active.day, totals.get(active.day)) : ""}
            </span>
        </figure>
    );
}
