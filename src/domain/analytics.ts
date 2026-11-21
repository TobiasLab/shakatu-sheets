import type { HistoryQuery } from "./history";
import { saleMultiplier } from "./session";

export type AnalyticsQuery = Omit<HistoryQuery, "offset" | "limit"> & { rareMinUnitValue: number };

export type AnalyticsSession = {
    id: string;
    grindSpotId: string;
    finishedAt: number;
    elapsedMs: number;
    net: number;
    // After-tax value of the session's rare items, which the net includes.
    rareValue: number;
    // Its hours were typed in (net samples, but none between start and end), so when it was played is unknown.
    hoursTypedIn: boolean;
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
    // The part recorded at a market price, which today's prices revalue.
    marketQuantity: number;
    marketValue: number;
};

// A rare item's quantity in one timed session, and the part of it recorded at a time into the session.
export type RareLoot = { sessionId: string; name: string; quantity: number };
export type RareEvent = { sessionId: string; name: string; elapsedMs: number; quantity: number };

// A timed session's net at every whole stretch of elapsed time from 0, held at its latest sample.
export type SessionPacing = { sessionId: string; marks: number[] };

export type HistoryAnalytics = {
    sessions: AnalyticsSession[];
    items: AnalyticsItem[];
    rareLoot: RareLoot[];
    rareEvents: RareEvent[];
    pacing: SessionPacing[];
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

export type RateSpread = { min: number; q1: number; median: number; q3: number; max: number };

// Quartiles interpolate between the sorted values (the spreadsheet QUARTILE.INC method), so two sessions still give
// a middle half between them.
export function rateSpread(values: number[]): RateSpread | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (share: number) => {
        const rank = share * (sorted.length - 1);
        const below = Math.floor(rank);
        const above = Math.min(below + 1, sorted.length - 1);
        return sorted[below] + (sorted[above] - sorted[below]) * (rank - below);
    };
    return { min: sorted[0], q1: at(0.25), median: at(0.5), q3: at(0.75), max: sorted[sorted.length - 1] };
}

export type ConsistencyView = "total" | "base";

// Per spot, how far apart its sessions' net per hour lie: with rare drops ("total") or without them ("base").
// Spots with the higher median come first.
export function spotConsistency(analytics: HistoryAnalytics, view: ConsistencyView) {
    const rates = new Map<string, number[]>();
    for (const session of timed(analytics.sessions)) {
        const value = view === "total" ? session.net : session.net - session.rareValue;
        const spot = rates.get(session.grindSpotId) ?? [];
        spot.push((value * HOUR_MS) / session.elapsedMs);
        rates.set(session.grindSpotId, spot);
    }
    return [...rates]
        .map(([grindSpotId, values]) => ({
            grindSpotId,
            sessionCount: values.length,
            spread: rateSpread(values) as RateSpread,
        }))
        .sort((a, b) => b.spread.median - a.spread.median || a.grindSpotId.localeCompare(b.grindSpotId));
}

// Matches the stretch the database measures pacing in.
export const PACING_STRETCH_MS = 15 * 60_000;

// For each stretch into a session, the net per hour earned in it, averaged over the sessions that lasted through it.
// Every session counts once per stretch, since each stretch is the same length.
export function pacingStretches(pacing: SessionPacing[]) {
    const stretches: { startMs: number; rate: number; sessionCount: number }[] = [];
    for (const { marks } of pacing) {
        for (let index = 1; index < marks.length; index++) {
            if (!stretches[index - 1]) {
                stretches[index - 1] = { startMs: (index - 1) * PACING_STRETCH_MS, rate: 0, sessionCount: 0 };
            }
            const stretch = stretches[index - 1];
            stretch.rate += ((marks[index] - marks[index - 1]) * HOUR_MS) / PACING_STRETCH_MS;
            stretch.sessionCount += 1;
        }
    }
    return stretches.map((stretch) => ({ ...stretch, rate: stretch.rate / stretch.sessionCount }));
}

// Consumables are what loot minus net leaves over the timed sessions: the expenses those sessions recorded. Both sums
// add up float products in different groupings, so the difference is rounded to whole silver.
function recordedExpenses(analytics: HistoryAnalytics) {
    const net = timed(analytics.sessions).reduce((total, session) => total + session.net, 0);
    const loot = analytics.items.reduce((total, item) => total + item.value, 0);
    return Math.round(loot - net) || 0;
}

export function consumableCost(analytics: HistoryAnalytics) {
    const sessions = timed(analytics.sessions);
    const elapsedMs = sessions.reduce((total, session) => total + session.elapsedMs, 0);
    const loot = analytics.items.reduce((total, item) => total + item.value, 0);
    const expenses = recordedExpenses(analytics);
    return {
        perHour: elapsedMs > 0 ? (expenses * HOUR_MS) / elapsedMs : null,
        shareOfLoot: loot > 0 ? expenses / loot : null,
    };
}

export type PriceImport = { itemId: number; basePrice: number; fetchedAt: number };

// Each item's imports in time order, as the database returns them, with its latest price and the change since its first.
export function priceHistory(imports: PriceImport[]) {
    const byItem = new Map<number, PriceImport[]>();
    for (const price of imports) {
        const list = byItem.get(price.itemId) ?? [];
        list.push(price);
        byItem.set(price.itemId, list);
    }
    return new Map(
        [...byItem].map(([itemId, points]) => {
            const first = points[0];
            const latest = points[points.length - 1];
            return [
                itemId,
                { points, latest, change: first.basePrice > 0 ? latest.basePrice / first.basePrice - 1 : null },
            ];
        }),
    );
}

// Past loot recorded at a market price, valued at its item's latest imported price after tax. Everything else (loot
// recorded at a vendor price, items with no import) keeps its recorded value, so the total still covers all loot;
// consumables keep their recorded cost.
export function todayValues(
    analytics: HistoryAnalytics,
    marketItemIds: Map<string, number>,
    latestPrices: Map<number, number>,
) {
    const sessions = timed(analytics.sessions);
    const elapsedMs = sessions.reduce((total, session) => total + session.elapsedMs, 0);
    if (elapsedMs === 0) return null;
    const expenses = recordedExpenses(analytics);
    // Every item's silver per hour; `pricedItems` counts those valued at a market price rather than as recorded.
    const itemPerHour = new Map<string, number>();
    let pricedItems = 0;
    let loot = 0;
    for (const item of analytics.items) {
        const itemId = marketItemIds.get(item.name);
        const price = itemId === undefined ? undefined : latestPrices.get(itemId);
        const priced = price !== undefined && item.marketQuantity > 0;
        const value = priced
            ? item.value - item.marketValue + item.marketQuantity * price * saleMultiplier("market")
            : item.value;
        if (priced) pricedItems += 1;
        itemPerHour.set(item.name, (value * HOUR_MS) / elapsedMs);
        loot += value;
    }
    return { netRate: ((loot - expenses) * HOUR_MS) / elapsedMs, itemPerHour, pricedItems };
}

// Recorded net added up session by session in completion order, as History's recorded net counts it.
export function cumulativeNet(analytics: HistoryAnalytics) {
    let net = 0;
    return analytics.sessions.map((session) => {
        net += session.net;
        return { id: session.id, grindSpotId: session.grindSpotId, finishedAt: session.finishedAt, net };
    });
}

export type HeatmapCell = { trackedMs: number; net: number };

// Longer sessions are left out of the heatmap: their hours were almost certainly typed in.
const HEATMAP_MAX_SESSION_MS = 24 * HOUR_MS;

// Tracked time and net per local weekday (0 = Monday) and hour of day. Sessions store no start time once paused, so
// each is placed from its completion minus its tracked time up to its completion, earning at a steady rate. Sessions
// whose hours were typed in are left out: they were played at some unknown earlier time.
export function weeklyHeatmap(analytics: HistoryAnalytics): HeatmapCell[][] {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ trackedMs: 0, net: 0 })));
    for (const session of timed(analytics.sessions)) {
        if (session.elapsedMs > HEATMAP_MAX_SESSION_MS || session.hoursTypedIn) continue;
        let at = session.finishedAt - session.elapsedMs;
        while (at < session.finishedAt) {
            const date = new Date(at);
            const nextHour = new Date(
                date.getFullYear(),
                date.getMonth(),
                date.getDate(),
                date.getHours() + 1,
            ).getTime();
            const end = Math.min(nextHour, session.finishedAt);
            const cell = cells[(date.getDay() + 6) % 7][date.getHours()];
            cell.trackedMs += end - at;
            cell.net += (session.net * (end - at)) / session.elapsedMs;
            at = end;
        }
    }
    return cells;
}
