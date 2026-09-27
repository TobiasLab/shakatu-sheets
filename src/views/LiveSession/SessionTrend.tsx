import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { MIN_TREND_MS, netAt, recentRate, type TrendSample, trendPoints } from "../../domain/trend";
import { formatDuration, formatSilver } from "../../format";
import styles from "./LiveSession.module.css";

const WIDTH = 320;
const HEIGHT = 56;
const RECENT_WINDOW_MS = 30 * 60_000;

export function SessionTrend({ samples, elapsedMs, net }: { samples: TrendSample[]; elapsedMs: number; net: number }) {
    const [hoverMs, setHoverMs] = useState<number | null>(null);
    const points = trendPoints(samples, elapsedMs, net);
    if (elapsedMs < MIN_TREND_MS || points.length < 2) return <div className={styles.Trend} aria-hidden="true" />;

    const low = Math.min(0, ...points.map((point) => point.net));
    const high = Math.max(1, ...points.map((point) => point.net));
    const x = (ms: number) => (ms / elapsedMs) * WIDTH;
    const y = (value: number) => HEIGHT - 3 - ((value - low) / (high - low)) * (HEIGHT - 6);
    const line = points.map((point) => `${x(point.elapsedMs).toFixed(1)},${y(point.net).toFixed(1)}`).join(" ");
    const area = `0,${y(0)} ${line} ${WIDTH},${y(0)}`;
    const recent = recentRate(points, RECENT_WINDOW_MS);
    const shownMs = hoverMs ?? elapsedMs;
    const shownNet = hoverMs === null ? net : netAt(points, hoverMs);

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
        <figure className={styles.Trend}>
            <figcaption>
                <span>Net over time</span>
                {hoverMs !== null ? (
                    <span>
                        <strong>{formatSilver(shownNet, true)}</strong> at {formatDuration(shownMs)}
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
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Arrow keys move the same readout as pointer hover.
                tabIndex={0}
                role="img"
                aria-label={`Net ${formatSilver(net, true)} after ${formatDuration(elapsedMs)}${
                    recent === null ? "" : `, ${formatSilver(recent, true)} per hour over the last 30 minutes`
                }`}
                onPointerMove={track}
                onPointerLeave={() => setHoverMs(null)}
                onKeyDown={step}
                onBlur={() => setHoverMs(null)}
            >
                <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                    {low < 0 && <line className={styles.TrendZero} x1="0" x2={WIDTH} y1={y(0)} y2={y(0)} />}
                    <line className={styles.TrendAverage} x1="0" y1={y(0)} x2={WIDTH} y2={y(net)} />
                    <polygon className={styles.TrendArea} points={area} />
                    <polyline className={styles.TrendLine} points={line} />
                </svg>
                <i
                    className={styles.TrendDot}
                    style={{ left: `${(x(shownMs) / WIDTH) * 100}%`, top: `${(y(shownNet) / HEIGHT) * 100}%` }}
                />
                {hoverMs !== null && (
                    <i className={styles.TrendCrosshair} style={{ left: `${(x(hoverMs) / WIDTH) * 100}%` }} />
                )}
            </div>
        </figure>
    );
}
