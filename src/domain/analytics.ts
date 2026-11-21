import type { HistoryQuery } from "./history";

export type AnalyticsQuery = Omit<HistoryQuery, "offset" | "limit"> & { rareMinUnitValue: number };

export type AnalyticsSession = {
    id: string;
    grindSpotId: string;
    finishedAt: number;
    elapsedMs: number;
    net: number;
    // After-tax value of the session's rare items, which the net includes.
    rareValue: number;
};

// One item's loot across the sessions with tracked time; rates are quantity per hour in sessions where it dropped.
export type AnalyticsItem = {
    name: string;
    rare: boolean;
    quantity: number;
    value: number;
    sessionCount: number;
    minRate: number;
    maxRate: number;
};

export type HistoryAnalytics = { sessions: AnalyticsSession[]; items: AnalyticsItem[] };

const HOUR_MS = 3_600_000;

// Rates pool every session with tracked time, as History's net per hour does: a long session weighs more than a short one.
function timed(sessions: AnalyticsSession[]) {
    return sessions.filter((session) => session.elapsedMs > 0);
}

export function analyticsSummary(analytics: HistoryAnalytics) {
    const sessions = timed(analytics.sessions);
    const elapsedMs = sessions.reduce((total, session) => total + session.elapsedMs, 0);
    const net = sessions.reduce((total, session) => total + session.net, 0);
    const rare = sessions.reduce((total, session) => total + session.rareValue, 0);
    const loot = analytics.items.reduce((total, item) => total + item.value, 0);
    const rareLoot = analytics.items.reduce((total, item) => total + (item.rare ? item.value : 0), 0);
    const perHour = (value: number) => (elapsedMs > 0 ? (value * HOUR_MS) / elapsedMs : null);
    return {
        // Everything except rare drops, after consumables, so base and rare add up to the net per hour.
        baseRate: perHour(net - rare),
        rareRate: perHour(rare),
        rareShare: loot > 0 ? rareLoot / loot : null,
    };
}

export function itemRates(analytics: HistoryAnalytics) {
    const sessions = timed(analytics.sessions);
    const elapsedMs = sessions.reduce((total, session) => total + session.elapsedMs, 0);
    const loot = analytics.items.reduce((total, item) => total + item.value, 0);
    if (elapsedMs === 0) return [];
    return analytics.items.map((item) => ({
        name: item.name,
        rare: item.rare,
        perHour: (item.quantity * HOUR_MS) / elapsedMs,
        // A session without the item had none of it per hour.
        lowRate: item.sessionCount < sessions.length ? 0 : item.minRate,
        highRate: item.maxRate,
        sessionCount: item.sessionCount,
        timedSessionCount: sessions.length,
        silverPerHour: (item.value * HOUR_MS) / elapsedMs,
        share: loot > 0 ? item.value / loot : 0,
    }));
}

export function sessionRates(analytics: HistoryAnalytics) {
    return timed(analytics.sessions).map((session) => ({
        id: session.id,
        grindSpotId: session.grindSpotId,
        finishedAt: session.finishedAt,
        rate: (session.net * HOUR_MS) / session.elapsedMs,
    }));
}
