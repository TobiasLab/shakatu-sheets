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

// A rare item's quantity in one timed session, and the part of it recorded at a time into the session.
export type RareLoot = { sessionId: string; name: string; quantity: number };
export type RareEvent = { sessionId: string; name: string; elapsedMs: number; quantity: number };

export type HistoryAnalytics = {
    sessions: AnalyticsSession[];
    items: AnalyticsItem[];
    rareLoot: RareLoot[];
    rareEvents: RareEvent[];
};

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

type PlacedDrop = {
    name: string;
    sessionId: string;
    finishedAt: number;
    quantity: number;
    // Time into the session, or null when it was not recorded.
    atMs: number | null;
    // Tracked time across the timed sessions in order, up to the drop. A drop without a time sits at its session's end.
    positionMs: number;
};

export type RareDrop = PlacedDrop & {
    // Tracked time since the previous drop of the same item; null for its first drop.
    sinceMs: number | null;
    // This drop or the previous one has no time, so sinceMs is approximate.
    approximate: boolean;
};

// Rare drops in the order they happened, across sessions in completion order.
export function rareDrops(analytics: HistoryAnalytics): RareDrop[] {
    const starts = new Map<string, { startMs: number; session: AnalyticsSession }>();
    let trackedMs = 0;
    for (const session of timed(analytics.sessions)) {
        starts.set(session.id, { startMs: trackedMs, session });
        trackedMs += session.elapsedMs;
    }
    const events = new Map<string, RareEvent[]>();
    for (const event of analytics.rareEvents) {
        const key = `${event.sessionId}\n${event.name}`;
        const list = events.get(key) ?? [];
        list.push(event);
        events.set(key, list);
    }
    const drops: PlacedDrop[] = [];
    for (const loot of analytics.rareLoot) {
        const start = starts.get(loot.sessionId);
        if (!start) continue;
        const { startMs, session } = start;
        const drop = { name: loot.name, sessionId: loot.sessionId, finishedAt: session.finishedAt };
        let recorded = 0;
        for (const event of events.get(`${loot.sessionId}\n${loot.name}`) ?? []) {
            const atMs = Math.min(event.elapsedMs, session.elapsedMs);
            drops.push({ ...drop, quantity: event.quantity, atMs, positionMs: startMs + atMs });
            recorded += event.quantity;
        }
        // Loot entered before the timer started, or in a session without drop times, has no time.
        if (loot.quantity > recorded) {
            drops.push({
                ...drop,
                quantity: loot.quantity - recorded,
                atMs: null,
                positionMs: startMs + session.elapsedMs,
            });
        }
    }
    drops.sort((a, b) => a.positionMs - b.positionMs || a.name.localeCompare(b.name));
    const previous = new Map<string, PlacedDrop>();
    return drops.map((drop) => {
        const before = previous.get(drop.name);
        previous.set(drop.name, drop);
        return {
            ...drop,
            sinceMs: before ? drop.positionMs - before.positionMs : null,
            approximate: drop.atMs === null || before?.atMs === null,
        };
    });
}

// Per rare item, in the item table's order: how often it drops over the tracked time and how long since it last did.
export function rareItemStats(analytics: HistoryAnalytics, drops: RareDrop[]) {
    const trackedMs = timed(analytics.sessions).reduce((total, session) => total + session.elapsedMs, 0);
    return analytics.items
        .filter((item) => item.rare)
        .flatMap((item) => {
            const itemDrops = drops.filter((drop) => drop.name === item.name);
            const count = itemDrops.reduce((total, drop) => total + drop.quantity, 0);
            const last = itemDrops[itemDrops.length - 1];
            if (!last || trackedMs === 0) return [];
            const averageGapMs = trackedMs / count;
            const sinceLastMs = trackedMs - last.positionMs;
            return [
                {
                    name: item.name,
                    count,
                    // Where each drop falls along the tracked time, from 0 to 1.
                    positions: itemDrops.map((drop) => drop.positionMs / trackedMs),
                    averageGapMs,
                    sinceLastMs,
                    // The last drop has no time, so it may have come earlier in its session than its end.
                    sinceLastIsMinimum: last.atMs === null,
                    // At the item's own average rate, a gap at least this long happens with this chance.
                    gapChance: Math.exp(-sinceLastMs / averageGapMs),
                },
            ];
        });
}
