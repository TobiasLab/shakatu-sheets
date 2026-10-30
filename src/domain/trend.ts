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

// The pace view plots silver/hour over the trailing window. Before the window has elapsed it covers the time since the
// start, but never less than the minimum span, so one drop in the first minutes cannot dwarf the rest of the line.
export const PACE_WINDOW_MS = 30 * 60_000;
export const PACE_MIN_SPAN_MS = 5 * 60_000;

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

export function paceAt(points: TrendSample[], elapsedMs: number): number {
    const from = Math.max(0, elapsedMs - PACE_WINDOW_MS);
    const spanMs = Math.max(elapsedMs - from, PACE_MIN_SPAN_MS);
    return (heldNetAt(points, elapsedMs) - heldNetAt(points, from)) / (spanMs / 3_600_000);
}

// Pace changes only when a sample enters the window or leaves it. Once the window is full, pace is flat between those
// changes, so the point just before each one keeps the jump upright. Before then the span still grows, and joining the
// changes draws a smooth curve instead of a dip after every sample.
export function paceSeries(points: TrendSample[], elapsedMs: number): { elapsedMs: number; value: number }[] {
    const times = new Set([0, elapsedMs]);
    for (const point of points) {
        for (const change of [point.elapsedMs, point.elapsedMs + PACE_WINDOW_MS]) {
            if (change <= 0 || change > elapsedMs) continue;
            if (change > PACE_WINDOW_MS) times.add(change - 1);
            times.add(change);
        }
    }
    return [...times].sort((left, right) => left - right).map((at) => ({ elapsedMs: at, value: paceAt(points, at) }));
}

// The pace at the end of the session, once a whole window has elapsed.
export function recentRate(points: TrendSample[]): number | null {
    const end = points[points.length - 1];
    if (!end || end.elapsedMs < PACE_WINDOW_MS) return null;
    return paceAt(points, end.elapsedMs);
}

// Which drops get a marker on the trend. Retune spikes by changing these three values.
export const SPIKE_MIN_SHARE_OF_NET = 0.1;
export const SPIKE_MAX_MARKERS = 5;
// Markers closer than this share of the session's duration would overlap, so only the more valuable one stays.
export const SPIKE_MIN_GAP_SHARE = 0.08;

export function spikeDrops(drops: TrendDrop[], elapsedMs: number, net: number): TrendDrop[] {
    const minimum = Math.max(1, SPIKE_MIN_SHARE_OF_NET * net);
    const minGapMs = SPIKE_MIN_GAP_SHARE * elapsedMs;
    const spikes: TrendDrop[] = [];
    for (const drop of [...drops].sort((left, right) => right.value - left.value)) {
        if (spikes.length === SPIKE_MAX_MARKERS || drop.value < minimum) break;
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
