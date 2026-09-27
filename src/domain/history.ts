import type { SessionState } from "./session";

export type HistoryQuery = {
    region: SessionState["region"];
    grindSpotId: string | null;
    finishedFromMs: number | null;
    finishedBeforeMs: number | null;
    offset: number;
    limit: number;
};

export type SpotSummary = {
    grindSpotId: string;
    sessionCount: number;
    elapsedMs: number;
    net: number;
    timedNet: number;
    zeroDurationCount: number;
    lastFinishedAt: number;
};

export function netPerHour(summary: Pick<SpotSummary, "elapsedMs" | "timedNet">): number | null {
    return summary.elapsedMs > 0 ? (summary.timedNet / summary.elapsedMs) * 3_600_000 : null;
}

export function summarizeHistory(spots: SpotSummary[], grindSpotId: string | null) {
    return spots
        .filter((spot) => grindSpotId === null || spot.grindSpotId === grindSpotId)
        .reduce(
            (total, spot) => ({
                sessionCount: total.sessionCount + spot.sessionCount,
                elapsedMs: total.elapsedMs + spot.elapsedMs,
                net: total.net + spot.net,
                timedNet: total.timedNet + spot.timedNet,
                zeroDurationCount: total.zeroDurationCount + spot.zeroDurationCount,
            }),
            { sessionCount: 0, elapsedMs: 0, net: 0, timedNet: 0, zeroDurationCount: 0 },
        );
}

export function rankSpots(spots: SpotSummary[]) {
    return [...spots].sort((a, b) => {
        const aRate = netPerHour(a);
        const bRate = netPerHour(b);
        if (aRate === null && bRate !== null) return 1;
        if (bRate === null && aRate !== null) return -1;
        return (bRate ?? 0) - (aRate ?? 0) || a.grindSpotId.localeCompare(b.grindSpotId);
    });
}

export function historyDateBoundary(value: string, nextDay = false): number | null {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error("Enter a valid completion date.");
    const [, year, month, day] = match.map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        throw new Error("Enter a valid completion date.");
    }
    if (nextDay) date.setDate(date.getDate() + 1);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Choose a date on or after January 1, 1970.");
    return timestamp;
}
