import { describe, expect, it } from "vitest";
import { historyDateBoundary, netPerHour, rankSpots, type SpotSummary, summarizeHistory } from "./history";
import { calculateEntryTotals, type SessionEntry } from "./session";

const spot: SpotSummary = {
    grindSpotId: "a",
    sessionCount: 2,
    elapsedMs: 7_200_000,
    net: 250_000_000,
    timedNet: 250_000_000,
    zeroDurationCount: 0,
    lastFinishedAt: 1_000,
};

describe("history comparisons", () => {
    it("weights 100m/30 minutes and 150m/90 minutes by duration", () => {
        expect(netPerHour(spot)).toBe(125_000_000);
        const combined = summarizeHistory(
            [
                { ...spot, sessionCount: 1, elapsedMs: 1_800_000, net: 100_000_000, timedNet: 100_000_000 },
                { ...spot, sessionCount: 1, elapsedMs: 5_400_000, net: 150_000_000, timedNet: 150_000_000 },
            ],
            null,
        );
        expect(combined.sessionCount).toBe(2);
        expect(netPerHour(combined)).toBe(125_000_000);
    });

    it("keeps zero-duration earnings in recorded net but out of the rate", () => {
        const combined = summarizeHistory(
            [spot, { ...spot, sessionCount: 1, elapsedMs: 0, net: 900_000_000, timedNet: 0, zeroDurationCount: 1 }],
            null,
        );
        expect(combined.net).toBe(1_150_000_000);
        expect(combined.sessionCount).toBe(3);
        expect(combined.zeroDurationCount).toBe(1);
        expect(netPerHour(combined)).toBe(125_000_000);
        expect(netPerHour({ elapsedMs: 0, timedNet: 0 })).toBeNull();
        expect(summarizeHistory([spot], "missing").sessionCount).toBe(0);
    });

    it("ranks losses above undefined rates and breaks equal rates by spot ID", () => {
        const rows = [
            { ...spot, grindSpotId: "z", timedNet: -100 },
            { ...spot, grindSpotId: "none", elapsedMs: 0 },
            { ...spot, grindSpotId: "b" },
            spot,
        ];
        expect(rankSpots(rows).map((row) => row.grindSpotId)).toEqual(["a", "b", "z", "none"]);
        expect(rows[0].grindSpotId).toBe("z");
    });

    it("matches the SQL valuation fixture using stored multipliers and expenses", () => {
        const entry: SessionEntry = {
            id: "a",
            name: "loot",
            quantity: 2,
            unitPrice: 101,
            valuation: "market",
            saleMultiplier: 0.845,
            source: "manual",
            createdAt: 0,
        };
        const totals = calculateEntryTotals([
            entry,
            { ...entry, quantity: 3, unitPrice: 10, valuation: "vendor", saleMultiplier: 1 },
            { ...entry, quantity: 1, unitPrice: 250, valuation: "expense", saleMultiplier: 0 },
        ]);
        expect(totals.net).toBeCloseTo(-49.31, 8);
    });
});

describe("completion dates", () => {
    it("uses local midnight and an exclusive next-day boundary", () => {
        expect(historyDateBoundary("2026-09-16")).toBe(new Date(2026, 8, 16).getTime());
        expect(historyDateBoundary("2026-09-16", true)).toBe(new Date(2026, 8, 17).getTime());
        expect(historyDateBoundary("2026-12-31", true)).toBe(new Date(2027, 0, 1).getTime());
        expect(historyDateBoundary("")).toBeNull();
        expect(() => historyDateBoundary("2026-02-30")).toThrow();
        expect(() => historyDateBoundary("not-a-date")).toThrow();
    });

    it("advances the calendar date across daylight-saving changes", () => {
        // Run this file with TZ=America/New_York to exercise 23- and 25-hour days.
        for (const [month, day] of [
            [2, 8],
            [10, 1],
        ]) {
            const value = `2026-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            expect(historyDateBoundary(value, true)).toBe(new Date(2026, month, day + 1).getTime());
        }
    });
});
