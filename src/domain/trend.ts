export type TrendSample = { elapsedMs: number; net: number };

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
