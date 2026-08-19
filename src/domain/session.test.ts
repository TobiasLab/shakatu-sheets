import { describe, expect, it } from "vitest";
import {
    calculateTotals,
    createSession,
    getElapsedMs,
    pauseRestoredSession,
    reduceSession,
    type SessionEntry,
} from "./session";

function entry(overrides: Partial<SessionEntry>): SessionEntry {
    return {
        id: "entry",
        name: "Test item",
        quantity: 1,
        unitPrice: 100,
        valuation: "vendor",
        saleMultiplier: 1,
        createdAt: 0,
        ...overrides,
    };
}

describe("session timing", () => {
    it("accumulates elapsed time across pauses", () => {
        const running = reduceSession(createSession(), { type: "start", now: 1_000 });
        const paused = reduceSession(running, { type: "pause", now: 6_000 });
        const resumed = reduceSession(paused, { type: "resume", now: 10_000 });

        expect(getElapsedMs(resumed, 13_000)).toBe(8_000);
    });

    it("pauses a running session restored after the application was closed", () => {
        const running = { ...createSession(), status: "running" as const, startedAt: 1_000, elapsedMs: 2_000 };

        expect(pauseRestoredSession(running, 6_000)).toMatchObject({
            status: "paused",
            startedAt: null,
            elapsedMs: 7_000,
        });
    });

    it("does not mutate a finished session", () => {
        const finished = { ...createSession(), status: "finished" as const };
        const changed = reduceSession(finished, { type: "add-entry", entry: entry({}) });

        expect(changed).toBe(finished);
    });

    it("ignores clock adjustments that move backwards", () => {
        const running = { ...createSession(), status: "running" as const, startedAt: 5_000, elapsedMs: 2_000 };

        expect(getElapsedMs(running, 4_000)).toBe(2_000);
    });

    it("only resets finished sessions", () => {
        const running = { ...createSession(), status: "running" as const, startedAt: 1_000 };

        expect(reduceSession(running, { type: "reset" })).toBe(running);
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
