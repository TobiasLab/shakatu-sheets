import { describe, expect, it } from "vitest";
import { type AnalyticsSession, analyticsSummary, type HistoryAnalytics, itemRates, sessionRates } from "./analytics";

const HOUR_MS = 3_600_000;

function session(id: string, elapsedMs: number, net: number, rareValue = 0): AnalyticsSession {
    return { id, grindSpotId: "ash", finishedAt: 1_000, elapsedMs, net, rareValue };
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
        const untimed = { sessions: [session("untimed", 0, 50_000_000)], items: [] };
        expect(analyticsSummary(untimed)).toEqual({ baseRate: null, rareRate: null, rareShare: null });
        expect(itemRates(untimed)).toEqual([]);
        expect(sessionRates(untimed)).toEqual([]);
    });
});
