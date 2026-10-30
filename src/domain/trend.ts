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

export function recentRate(points: TrendSample[], windowMs: number): number | null {
    const end = points[points.length - 1];
    if (!end || end.elapsedMs < windowMs) return null;
    return (end.net - netAt(points, end.elapsedMs - windowMs)) / (windowMs / 3_600_000);
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
