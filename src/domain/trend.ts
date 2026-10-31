import { calculateQuantityPerHour } from "./session";

export type TrendSample = { elapsedMs: number; net: number };
// Loot one entry gained by a save, valued after tax at the entry's current price.
export type TrendDrop = { elapsedMs: number; name: string; quantity: number; value: number };
export type SessionTrendData = { samples: TrendSample[]; drops: TrendDrop[] };

// Shorter sessions have too little elapsed time to draw a line.
export const MIN_TREND_MS = 60_000;

// Sessions created before net samples were recorded have none, and a straight line to the final net would mislead.
export function hasRecordedTrend(samples: TrendSample[], elapsedMs: number): boolean {
    return samples.length > 0 && elapsedMs >= MIN_TREND_MS;
}

// Persisted samples record net whenever it changed; the live session supplies the current end point.
export function trendPoints(samples: TrendSample[], elapsedMs: number, net: number): TrendSample[] {
    const start = samples.find((sample) => sample.elapsedMs === 0) ?? { elapsedMs: 0, net: 0 };
    const middle = samples.filter((sample) => sample.elapsedMs > 0 && sample.elapsedMs < elapsedMs);
    return elapsedMs > 0 ? [start, ...middle, { elapsedMs, net }] : [start];
}

export function netAt(points: TrendSample[], elapsedMs: number): number {
    const next = points.findIndex((point) => point.elapsedMs >= elapsedMs);
    if (next === -1) return points[points.length - 1]?.net ?? 0;
    if (next === 0) return points[0].net;
    const before = points[next - 1];
    const after = points[next];
    const span = after.elapsedMs - before.elapsedMs;
    return span > 0 ? before.net + ((after.net - before.net) * (elapsedMs - before.elapsedMs)) / span : after.net;
}

// "Last 30 min" in the trend caption is the silver/hour over this trailing window.
const RECENT_WINDOW_MS = 30 * 60_000;

// Samples are stored only when net changes, so net holds its latest sample until the next one. Points are sorted by time.
function heldNetAt(points: TrendSample[], elapsedMs: number): number {
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (points[middle].elapsedMs <= elapsedMs) low = middle;
        else high = middle - 1;
    }
    return points[low]?.net ?? 0;
}

// The rate over the trailing window at the end of the session, once a whole window has elapsed.
export function recentRate(points: TrendSample[]): number | null {
    const end = points[points.length - 1];
    if (!end || end.elapsedMs < RECENT_WINDOW_MS) return null;
    return (end.net - heldNetAt(points, end.elapsedMs - RECENT_WINDOW_MS)) / (RECENT_WINDOW_MS / 3_600_000);
}

// The Silver/h view plots the session average up to each moment, so its end is the silver/hour the desk and overlay show.
export function averageAt(points: TrendSample[], elapsedMs: number): number {
    return calculateQuantityPerHour(heldNetAt(points, elapsedMs), elapsedMs) ?? 0;
}

// With net held, the average falls after every sample until the next one. Samples a minute or so apart are joined
// directly, so the line does not dip after each one; a longer quiet stretch is filled in so its decline shows and the
// jump that ends it stays upright.
const QUIET_STRETCH_MS = 5 * 60_000;
const QUIET_STRETCH_STEPS = 8;

export function averageSeries(points: TrendSample[], elapsedMs: number): { elapsedMs: number; value: number }[] {
    const times: number[] = [];
    let previous = 0;
    const changes = points.map((point) => point.elapsedMs).filter((at) => at > 0 && at < elapsedMs);
    for (const at of [...changes, elapsedMs]) {
        if (at - previous > QUIET_STRETCH_MS) {
            for (let step = 1; step < QUIET_STRETCH_STEPS; step++)
                times.push(previous + ((at - previous) * step) / QUIET_STRETCH_STEPS);
            times.push(at - 1);
        }
        times.push(at);
        previous = at;
    }
    return times.map((at) => ({ elapsedMs: at, value: averageAt(points, at) }));
}

// One drop in the first minutes keeps the average far above anything after it for a while. Values before this time do
// not set the Silver/h scale; the line runs along the edge there while the readout keeps the exact value.
export const AVERAGE_SCALE_FROM_MS = 15 * 60_000;

export function averageScaleFrom(elapsedMs: number): number {
    return Math.min(AVERAGE_SCALE_FROM_MS, elapsedMs / 2);
}

// A drop gets a marker on the trend when one item of it is worth at least this much after tax: the spot's rare drops.
export const SPIKE_MIN_UNIT_VALUE = 100_000_000;
// Markers closer than this share of the session's duration would overlap, so only the more valuable one stays.
export const SPIKE_MIN_GAP_SHARE = 0.08;

export function spikeDrops(drops: TrendDrop[], elapsedMs: number): TrendDrop[] {
    const minGapMs = SPIKE_MIN_GAP_SHARE * elapsedMs;
    const spikes: TrendDrop[] = [];
    for (const drop of [...drops].sort((left, right) => right.value - left.value)) {
        if (drop.quantity <= 0 || drop.value / drop.quantity < SPIKE_MIN_UNIT_VALUE) continue;
        if (drop.elapsedMs > elapsedMs) continue;
        if (spikes.some((spike) => Math.abs(spike.elapsedMs - drop.elapsedMs) < minGapMs)) continue;
        spikes.push(drop);
    }
    return spikes.sort((left, right) => left.elapsedMs - right.elapsedMs);
}

// The marker a pointer or keyboard position points at, if any lies within half the marker spacing.
export function spikeAt(spikes: TrendDrop[], elapsedMs: number, sessionMs: number): TrendDrop | null {
    let nearest: TrendDrop | null = null;
    for (const spike of spikes) {
        const distance = Math.abs(spike.elapsedMs - elapsedMs);
        if (
            distance <= (SPIKE_MIN_GAP_SHARE * sessionMs) / 2 &&
            (!nearest || distance < Math.abs(nearest.elapsedMs - elapsedMs))
        )
            nearest = spike;
    }
    return nearest;
}
