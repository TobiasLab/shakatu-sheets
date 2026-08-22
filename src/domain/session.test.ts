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
        const edited = reduceSession(finished, { type: "update-entry", id: "entry", quantity: 2, unitPrice: 200 });
        const retimed = reduceSession(finished, { type: "set-elapsed", elapsedMs: 3_600_000 });

        expect(changed).toBe(finished);
        expect(edited).toBe(finished);
        expect(retimed).toBe(finished);
    });

    it("ignores clock adjustments that move backwards", () => {
        const running = { ...createSession(), status: "running" as const, startedAt: 5_000, elapsedMs: 2_000 };

        expect(getElapsedMs(running, 4_000)).toBe(2_000);
    });

    it("only resets finished sessions", () => {
        const running = { ...createSession(), status: "running" as const, startedAt: 1_000 };

        expect(reduceSession(running, { type: "reset" })).toBe(running);
    });

    it("sets completed time and finishes a manually timed session", () => {
        const idle = createSession();
        const timed = reduceSession(idle, { type: "set-elapsed", elapsedMs: 5_400_000 });
        const finished = reduceSession(timed, { type: "finish", now: 10_000 });

        expect(timed.elapsedMs).toBe(5_400_000);
        expect(reduceSession(timed, { type: "set-elapsed", elapsedMs: -1 })).toBe(timed);
        expect(finished).toMatchObject({ status: "finished", elapsedMs: 5_400_000 });
    });

    it("only changes the grind spot on an empty idle session", () => {
        const idle = createSession();
        const changed = reduceSession(idle, { type: "set-grind-spot", grindSpotId: "stars-end-revamp" });
        const timed = { ...idle, elapsedMs: 1 };
        const looted = { ...idle, entries: [entry({})] };

        expect(changed.grindSpotId).toBe("stars-end-revamp");
        expect(reduceSession(timed, { type: "set-grind-spot", grindSpotId: "stars-end-revamp" })).toBe(timed);
        expect(reduceSession(looted, { type: "set-grind-spot", grindSpotId: "stars-end-revamp" })).toBe(looted);
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

describe("session entries", () => {
    it("aggregates matching entries and moves the updated row to the end", () => {
        const first = entry({ id: "first", name: "Caphras Stone", quantity: 2, createdAt: 1 });
        const other = entry({ id: "other", name: "Black Stone" });
        const session = { ...createSession(), entries: [first, other] };

        const updated = reduceSession(session, {
            type: "add-entry",
            entry: entry({ id: "new", name: "Caphras Stone", quantity: 3, createdAt: 2 }),
        });

        expect(updated.entries).toEqual([other, { ...first, quantity: 5, createdAt: 2 }]);
    });

    it("keeps entries with different unit prices separate", () => {
        const session = { ...createSession(), entries: [entry({ unitPrice: 100 })] };

        const updated = reduceSession(session, {
            type: "add-entry",
            entry: entry({ id: "new", unitPrice: 200 }),
        });

        expect(updated.entries).toHaveLength(2);
    });

    it("updates valid quantities and prices while rejecting invalid edits", () => {
        const session = { ...createSession(), entries: [entry({})] };
        const updated = reduceSession(session, { type: "update-entry", id: "entry", quantity: 12, unitPrice: 250 });
        const rejected = reduceSession(updated, { type: "update-entry", id: "entry", quantity: 0, unitPrice: 250 });

        expect(updated.entries[0]).toMatchObject({ quantity: 12, unitPrice: 250 });
        expect(rejected).toBe(updated);
    });
});
