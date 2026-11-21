import { describe, expect, it } from "vitest";
import {
    type AnalyticsSession,
    analyticsSummary,
    type HistoryAnalytics,
    itemRates,
    pacingStretches,
    rareDrops,
    rareItemStats,
    rateSpread,
    sessionRates,
    spotConsistency,
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
    pacing: [],
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
        const untimed = {
            sessions: [session("untimed", 0, 50_000_000)],
            items: [],
            rareLoot: [],
            rareEvents: [],
            pacing: [],
        };
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
            pacing: [],
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

    it("takes quartiles between sorted values", () => {
        expect(rateSpread([40, 10, 30, 20, 50])).toEqual({ min: 10, q1: 20, median: 30, q3: 40, max: 50 });
        expect(rateSpread([15, 210])).toEqual({ min: 15, q1: 63.75, median: 112.5, q3: 161.25, max: 210 });
        expect(rateSpread([7])).toEqual({ min: 7, q1: 7, median: 7, q3: 7, max: 7 });
        expect(rateSpread([])).toBeNull();
    });

    it("spreads each spot's timed sessions, with or without rare drops, highest median first", () => {
        const spots: HistoryAnalytics = {
            sessions: [
                { ...session("a", HOUR_MS, 210_000_000, 200_000_000), grindSpotId: "sycraia" },
                { ...session("b", 2 * HOUR_MS, 30_000_000), grindSpotId: "sycraia" },
                { ...session("untimed", 0, 900_000_000), grindSpotId: "sycraia" },
                { ...session("d", HOUR_MS, 20_000_000), grindSpotId: "stars" },
            ],
            items: [],
            rareLoot: [],
            rareEvents: [],
            pacing: [],
        };
        expect(spotConsistency(spots, "total")).toEqual([
            {
                grindSpotId: "sycraia",
                sessionCount: 2,
                spread: { min: 15_000_000, q1: 63_750_000, median: 112_500_000, q3: 161_250_000, max: 210_000_000 },
            },
            {
                grindSpotId: "stars",
                sessionCount: 1,
                spread: { min: 20_000_000, q1: 20_000_000, median: 20_000_000, q3: 20_000_000, max: 20_000_000 },
            },
        ]);
        expect(spotConsistency(spots, "base").map((spot) => [spot.grindSpotId, spot.spread.median])).toEqual([
            ["stars", 20_000_000],
            ["sycraia", 12_500_000],
        ]);
    });

    it("averages each quarter hour's net per hour over the sessions that lasted through it", () => {
        const stretches = pacingStretches([
            { sessionId: "hour", marks: [0, 5_000_000, 205_000_000, 205_000_000, 210_000_000] },
            { sessionId: "half", marks: [1_000_000, 1_000_000, 31_000_000] },
        ]);
        expect(stretches).toEqual([
            { startMs: 0, rate: 10_000_000, sessionCount: 2 },
            { startMs: 15 * 60_000, rate: 460_000_000, sessionCount: 2 },
            { startMs: 30 * 60_000, rate: 0, sessionCount: 1 },
            { startMs: 45 * 60_000, rate: 20_000_000, sessionCount: 1 },
        ]);
        expect(pacingStretches([])).toEqual([]);
    });
});
