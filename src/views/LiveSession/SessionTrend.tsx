import { type KeyboardEvent, type PointerEvent, useState } from "react";
import type { TrendView } from "../../api/preferences";
import { getDropIcon } from "../../data/grindSpots";
import {
    averageAt,
    averageScaleFrom,
    averageSeries,
    MIN_TREND_MS,
    netAt,
    recentRate,
    spikeAt,
    spikeDrops,
    type TrendDrop,
    type TrendSample,
    trendPoints,
} from "../../domain/trend";
import { formatDuration, formatSilver } from "../../format";
import styles from "./LiveSession.module.css";

const WIDTH = 320;
const HEIGHT = 56;

export function SessionTrend({
    samples,
    drops,
    grindSpotId,
    elapsedMs,
    net,
    view,
    onViewChange,
}: {
    samples: TrendSample[];
    drops: TrendDrop[];
    grindSpotId: string;
    elapsedMs: number;
    net: number;
    view: TrendView;
    onViewChange: (view: TrendView) => void;
}) {
    const [hoverMs, setHoverMs] = useState<number | null>(null);
    const points = trendPoints(samples, elapsedMs, net);
    if (elapsedMs < MIN_TREND_MS || points.length < 2) return <div className={styles.Trend} aria-hidden="true" />;

    const pace = view === "pace";
    const series = pace
        ? averageSeries(points, elapsedMs)
        : points.map((point) => ({ elapsedMs: point.elapsedMs, value: point.net }));
    const valueAt = (ms: number) => (pace ? averageAt(points, ms) : netAt(points, ms));
    const average = averageAt(points, elapsedMs);
    const unit = pace ? "/h" : "";
    const scaleFrom = pace ? averageScaleFrom(elapsedMs) : 0;
    const scaled = series.filter((point) => point.elapsedMs >= scaleFrom).map((point) => point.value);
    const low = Math.min(0, ...scaled);
    const high = Math.max(1, ...scaled);
    const x = (ms: number) => (ms / elapsedMs) * WIDTH;
    const y = (value: number) =>
        HEIGHT - 3 - ((Math.min(high, Math.max(low, value)) - low) / (high - low)) * (HEIGHT - 6);
    const line = series.map((point) => `${x(point.elapsedMs).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    const area = `${x(series[0].elapsedMs)},${y(0)} ${line} ${WIDTH},${y(0)}`;
    const recent = recentRate(points);
    const spikes = spikeDrops(drops, elapsedMs);
    const hoveredSpike = hoverMs === null ? null : spikeAt(spikes, hoverMs, elapsedMs);
    const shownMs = hoveredSpike?.elapsedMs ?? hoverMs ?? elapsedMs;
    const shownValue = valueAt(shownMs);
    const spikeName =
        hoveredSpike && hoveredSpike.quantity > 1
            ? `${hoveredSpike.name} ×${hoveredSpike.quantity}`
            : hoveredSpike?.name;
    const readout = hoveredSpike
        ? `${spikeName}, ${formatSilver(hoveredSpike.value, true)} at ${formatDuration(shownMs)}`
        : `${formatSilver(shownValue, true)}${unit} at ${formatDuration(shownMs)}`;
    const recentSummary = recent === null ? "" : `, ${formatSilver(recent, true)} per hour over the last 30 minutes`;
    const summary = pace
        ? `${formatSilver(average, true)} per hour session average after ${formatDuration(elapsedMs)}${recentSummary}`
        : `Net ${formatSilver(net, true)} after ${formatDuration(elapsedMs)}${recentSummary}`;
    const dropSummary =
        spikes.length === 0
            ? ""
            : `. Rare drops: ${spikes
                  .map(
                      (spike) =>
                          `${spike.name} ${formatSilver(spike.value, true)} at ${formatDuration(spike.elapsedMs)}`,
                  )
                  .join(", ")}`;

    function step(event: KeyboardEvent<HTMLDivElement>) {
        const current = hoverMs ?? elapsedMs;
        const next =
            event.key === "ArrowLeft"
                ? current - elapsedMs / 20
                : event.key === "ArrowRight"
                  ? current + elapsedMs / 20
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? elapsedMs
                      : null;
        if (event.key === "Escape") setHoverMs(null);
        if (next === null) return;
        event.preventDefault();
        setHoverMs(Math.min(elapsedMs, Math.max(0, next)));
    }

    function track(event: PointerEvent<HTMLDivElement>) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        setHoverMs(ratio * elapsedMs);
    }

    return (
        <figure className={styles.Trend} aria-label={pace ? "Silver per hour over time" : "Net over time"}>
            <figcaption>
                <fieldset className="segmented">
                    <legend className="sr-only">Graph</legend>
                    {(["net", "pace"] as const).map((option) => (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={view === option}
                            onClick={() => onViewChange(option)}
                        >
                            {option === "net" ? "Net" : "Silver/h"}
                        </button>
                    ))}
                </fieldset>
                {hoveredSpike ? (
                    <span className={styles.TrendReadout}>
                        <span className={styles.TrendSpikeName}>{spikeName}</span>
                        <span>
                            <strong>{formatSilver(hoveredSpike.value, true)}</strong> at {formatDuration(shownMs)}
                        </span>
                    </span>
                ) : hoverMs !== null ? (
                    <span>
                        <strong>
                            {formatSilver(shownValue, true)}
                            {unit}
                        </strong>{" "}
                        at {formatDuration(shownMs)}
                    </span>
                ) : (
                    recent !== null && (
                        <span>
                            Last 30 min <strong>{formatSilver(recent, true)}/h</strong>
                        </span>
                    )
                )}
            </figcaption>
            <div
                className={styles.TrendPlot}
                data-spikes={spikes.length > 0 || undefined}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={`${summary}${dropSummary}`}
                onPointerMove={track}
                onPointerLeave={() => setHoverMs(null)}
                onKeyDown={step}
                onBlur={() => setHoverMs(null)}
            >
                <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                    {low < 0 && <line className={styles.TrendZero} x1="0" x2={WIDTH} y1={y(0)} y2={y(0)} />}
                    {pace ? (
                        <line className={styles.TrendAverage} x1="0" y1={y(average)} x2={WIDTH} y2={y(average)} />
                    ) : (
                        <line className={styles.TrendAverage} x1="0" y1={y(0)} x2={WIDTH} y2={y(net)} />
                    )}
                    <polygon className={styles.TrendArea} points={area} />
                    <polyline className={styles.TrendLine} points={line} />
                </svg>
                <i
                    className={styles.TrendDot}
                    style={{ left: `${(x(shownMs) / WIDTH) * 100}%`, top: `${(y(shownValue) / HEIGHT) * 100}%` }}
                />
                {spikes.map((spike) => {
                    const icon = getDropIcon(grindSpotId, spike.name);
                    return (
                        <span
                            key={`${spike.elapsedMs}-${spike.name}`}
                            className={styles.TrendSpike}
                            data-active={spike === hoveredSpike || undefined}
                            style={{
                                left: `${(x(spike.elapsedMs) / WIDTH) * 100}%`,
                                height: `calc(${(y(valueAt(spike.elapsedMs)) / HEIGHT) * 100}% + var(--spike-space))`,
                            }}
                        >
                            {icon ? <img src={icon} alt="" /> : <b />}
                            <small>{formatSilver(spike.value, true)}</small>
                        </span>
                    );
                })}
                {hoverMs !== null && (
                    <i className={styles.TrendCrosshair} style={{ left: `${(x(shownMs) / WIDTH) * 100}%` }} />
                )}
            </div>
            {/* The arrow-key readout is only visual in the caption, so screen readers hear it here. */}
            <span className="sr-only" aria-live="polite">
                {hoverMs === null ? "" : readout}
            </span>
        </figure>
    );
}
