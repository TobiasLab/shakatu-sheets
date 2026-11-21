import { describe, expect, it } from "vitest";
import {
    type AnalyticsSession,
    analyticsSummary,
    type HistoryAnalytics,
    itemRates,
    rareDrops,
    rareItemStats,
    sessionRates,
} from "./analytics";

const HOUR_MS = 3_600_000;

function session(id: string, elapsedMs: number, net: number, rareValue = 0, finishedAt = 1_000): AnalyticsSession {
    return { id, grindSpotId: "ash", finishedAt, elapsedMs, net, rareValue };
}

const analytics: HistoryAnalytics = {
    sessions: [
        session("long", 3 * HOUR_MS, 600_000_000, 300_000_000),
        session("short", HOUR_MS, 100_000_000),
        session("untimed", 0, 50_000_000, 50_000_000),
    ],
    items: [
        { name: "Necklace", rare: true, quantity: 2, value: 300_000_000, sessionCount: 1, minRate: 0.5, maxRate: 0.5 },
        {
            name: "Cloth",
            rare: false,
            quantity: 4_000,
            value: 500_000_000,
            sessionCount: 2,
            minRate: 900,
            maxRate: 1_100,
        },
    ],
    rareLoot: [],
    rareEvents: [],
};

describe("history analytics", () => {
    it("pools tracked time so base and rare silver per hour add up to the net per hour", () => {
        const summary = analyticsSummary(analytics);
        expect(summary.baseRate).toBe(100_000_000);
        expect(summary.rareRate).toBe(75_000_000);
        expect((summary.baseRate ?? 0) + (summary.rareRate ?? 0)).toBe(700_000_000 / 4);
        expect(summary.rareShare).toBe(0.375);
    });

    it("rates items over every timed session, including those where an item did not drop", () => {
        expect(itemRates(analytics)).toEqual([
            {
                name: "Necklace",
                rare: true,
                perHour: 0.5,
                lowRate: 0,
                highRate: 0.5,
                sessionCount: 1,
                timedSessionCount: 2,
                silverPerHour: 75_000_000,
                share: 0.375,
            },
            {
                name: "Cloth",
                rare: false,
                perHour: 1_000,
                lowRate: 900,
                highRate: 1_100,
                sessionCount: 2,
                timedSessionCount: 2,
                silverPerHour: 125_000_000,
                share: 0.625,
            },
        ]);
    });

    it("plots each timed session's net per hour", () => {
        expect(sessionRates(analytics).map((point) => [point.id, point.rate])).toEqual([
            ["long", 200_000_000],
            ["short", 100_000_000],
        ]);
    });

    it("reports no rates without tracked time", () => {
        const untimed = { sessions: [session("untimed", 0, 50_000_000)], items: [], rareLoot: [], rareEvents: [] };
        expect(analyticsSummary(untimed)).toEqual({ baseRate: null, rareRate: null, rareShare: null });
        expect(itemRates(untimed)).toEqual([]);
        expect(sessionRates(untimed)).toEqual([]);
    });

    it("places rare drops along the tracked time and measures the gaps between them", () => {
        const item = (name: string, rare: boolean) => ({
            name,
            rare,
            quantity: 1,
            value: rare ? 900_000_000 : 1,
            sessionCount: 1,
            minRate: 1,
            maxRate: 1,
        });
        const drops: HistoryAnalytics = {
            sessions: [
                session("a", 2 * HOUR_MS, 0, 0, 1_000),
                session("b", HOUR_MS, 0, 0, 2_000),
                session("untimed", 0, 0, 0, 2_500),
                session("c", 3 * HOUR_MS, 0, 0, 3_000),
            ],
            items: [item("Necklace", true), item("Ring", true), item("Cloth", false)],
            rareLoot: [
                { sessionId: "a", name: "Necklace", quantity: 2 },
                { sessionId: "b", name: "Necklace", quantity: 1 },
                { sessionId: "c", name: "Necklace", quantity: 1 },
                { sessionId: "c", name: "Ring", quantity: 1 },
            ],
            rareEvents: [
                { sessionId: "a", name: "Necklace", elapsedMs: HOUR_MS / 2, quantity: 1 },
                { sessionId: "c", name: "Necklace", elapsedMs: 2 * HOUR_MS, quantity: 1 },
                { sessionId: "c", name: "Ring", elapsedMs: HOUR_MS, quantity: 1 },
            ],
        };
        const placed = rareDrops(drops);
        expect(
            placed.map((drop) => [
                drop.name,
                drop.sessionId,
                drop.atMs,
                drop.positionMs / HOUR_MS,
                drop.sinceMs,
                drop.approximate,
            ]),
        ).toEqual([
            ["Necklace", "a", HOUR_MS / 2, 0.5, null, false],
            // Loot without a recorded time sits at its session's end.
            ["Necklace", "a", null, 2, 1.5 * HOUR_MS, true],
            ["Necklace", "b", null, 3, HOUR_MS, true],
            ["Ring", "c", HOUR_MS, 4, null, false],
            ["Necklace", "c", 2 * HOUR_MS, 5, 2 * HOUR_MS, true],
        ]);
        const stats = rareItemStats(drops, placed);
        expect(stats.map(({ gapChance, ...rest }) => rest)).toEqual([
            {
                name: "Necklace",
                count: 4,
                positions: [0.5 / 6, 2 / 6, 3 / 6, 5 / 6],
                averageGapMs: 1.5 * HOUR_MS,
                sinceLastMs: HOUR_MS,
                sinceLastIsMinimum: false,
            },
            {
                name: "Ring",
                count: 1,
                positions: [4 / 6],
                averageGapMs: 6 * HOUR_MS,
                sinceLastMs: 2 * HOUR_MS,
                sinceLastIsMinimum: false,
            },
        ]);
        expect(stats[0].gapChance).toBeCloseTo(Math.exp(-1 / 1.5));
        expect(stats[1].gapChance).toBeCloseTo(Math.exp(-2 / 6));
    });
});
