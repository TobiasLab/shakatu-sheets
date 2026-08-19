import { describe, expect, it } from "vitest";
import { calculateTotals, getElapsedMs, initialSession, reduceSession, type SessionEntry } from "./session";

function entry(overrides: Partial<SessionEntry>): SessionEntry {
    return {
        id: "entry",
        name: "Test item",
        quantity: 1,
        unitPrice: 100,
        valuation: "vendor",
        saleMultiplier: 1,
        source: "manual",
        createdAt: 0,
        ...overrides,
    };
}

describe("session timing", () => {
    it("accumulates elapsed time across pauses", () => {
        const running = reduceSession(initialSession, { type: "start", now: 1_000 });
        const paused = reduceSession(running, { type: "pause", now: 6_000 });
        const resumed = reduceSession(paused, { type: "resume", now: 10_000 });

        expect(getElapsedMs(resumed, 13_000)).toBe(8_000);
    });
});

describe("session totals", () => {
    it("applies market tax and subtracts expenses", () => {
        const totals = calculateTotals(
            [
                entry({ quantity: 2, unitPrice: 1_000, valuation: "market", saleMultiplier: 0.845 }),
                entry({ id: "vendor", quantity: 3, unitPrice: 100 }),
                entry({ id: "expense", unitPrice: 200, valuation: "expense" }),
            ],
            3_600_000,
        );

        expect(totals.gross).toBe(2_300);
        expect(totals.expenses).toBe(200);
        expect(totals.net).toBe(1_790);
        expect(totals.netPerHour).toBe(1_790);
    });

    it("does not produce an hourly value before the timer starts", () => {
        expect(calculateTotals([entry({})], 0).netPerHour).toBe(0);
    });
});
