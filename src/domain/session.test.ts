import { describe, expect, it } from "vitest";
import {
    calculateQuantityPerHour,
    calculateTotals,
    createSession,
    getElapsedMs,
    isActiveSessionStatus,
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
        source: "manual",
        createdAt: 0,
        ...overrides,
    };
}

describe("session timing", () => {
    it("treats idle and paused sessions as active without running the timer", () => {
        expect(isActiveSessionStatus("idle")).toBe(true);
        expect(isActiveSessionStatus("running")).toBe(true);
        expect(isActiveSessionStatus("paused")).toBe(true);
        expect(isActiveSessionStatus("finished")).toBe(false);
    });

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

    it("imports recognized loot only into an empty idle session", () => {
        const idle = createSession();
        const recognized = entry({ source: "recognition", quantity: 20_630 });
        const action = {
            type: "import-recognition" as const,
            grindSpotId: "sycraia-lower-revamp",
            elapsedMs: 3_652_000,
            entries: [recognized],
        };
        const imported = reduceSession(idle, action);

        expect(imported).toMatchObject({ elapsedMs: 3_652_000, entries: [recognized] });
        expect(reduceSession({ ...idle, elapsedMs: 1 }, action)).toEqual({ ...idle, elapsedMs: 1 });
        expect(reduceSession(idle, { ...action, entries: [entry({})] })).toBe(idle);
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

describe("consumable preset application", () => {
    const consumable = (id = "consumable", quantity = 3) =>
        entry({
            id,
            name: "Perfume of Envy",
            valuation: "expense",
            garmothConsumableId: 1411,
            quantity,
            unitPrice: 100,
        });

    it("replaces consumables atomically without duplicating them or removing manual expenses", () => {
        const manual = entry({ id: "manual", name: "Perfume of Envy", valuation: "expense" });
        const initial = { ...createSession(), entries: [entry({}), manual, consumable()] };
        const next = reduceSession(initial, { type: "apply-consumables", entries: [consumable("new", 6)] });
        const repeated = reduceSession(next, { type: "apply-consumables", entries: [consumable("newer", 6)] });
        expect(repeated.entries).toEqual([entry({}), manual, consumable("newer", 6)]);
        expect(calculateTotals(repeated.entries, 3_600_000)).toMatchObject({ gross: 100, expenses: 700, net: -600 });
        expect(initial.entries[2].quantity).toBe(3);
    });

    it("does not merge manually entered rows with tagged consumables at the same price", () => {
        const initial = { ...createSession(), entries: [consumable()] };
        const next = reduceSession(initial, {
            type: "add-entry",
            entry: entry({ id: "manual", name: "Perfume of Envy", valuation: "expense" }),
        });
        expect(next.entries).toHaveLength(2);
        expect(next.entries[0].quantity).toBe(3);
    });

    it("preserves consumable identity when editing quantity or price and leaves finished sessions immutable", () => {
        const initial = { ...createSession(), entries: [consumable()] };
        const changed = reduceSession(initial, { type: "update-entry", id: "consumable", quantity: 2, unitPrice: 50 });
        expect(changed.entries[0]).toMatchObject({ quantity: 2, unitPrice: 50, garmothConsumableId: 1411 });
        const finished = { ...changed, status: "finished" as const };
        expect(reduceSession(finished, { type: "apply-consumables", entries: [consumable()] })).toBe(finished);
    });

    it("rejects consumable edits whose total exceeds safe integer precision", () => {
        const initial = { ...createSession(), entries: [consumable()] };
        expect(
            reduceSession(initial, {
                type: "update-entry",
                id: "consumable",
                quantity: 3,
                unitPrice: Number.MAX_SAFE_INTEGER,
            }),
        ).toBe(initial);
    });

    it("rejects invalid batches without applying part of the preset", () => {
        const initial = createSession();
        for (const entries of [
            [],
            [consumable(), consumable("duplicate")],
            [{ ...consumable(), quantity: 0 }],
            [{ ...consumable(), unitPrice: -1 }],
            [{ ...consumable(), unitPrice: Number.MAX_SAFE_INTEGER }],
            [{ ...consumable(), valuation: "vendor" as const }],
            [{ ...consumable(), garmothConsumableId: undefined }],
        ]) {
            expect(reduceSession(initial, { type: "apply-consumables", entries })).toBe(initial);
        }
    });
});

describe("quantity per hour", () => {
    it("has no rate before elapsed time is recorded", () => {
        expect(calculateQuantityPerHour(25, 0)).toBeNull();
    });

    it("normalizes quantities to an hour and preserves fractional drops", () => {
        expect(calculateQuantityPerHour(25, 1_800_000)).toBe(50);
        expect(calculateQuantityPerHour(1, 7_200_000)).toBe(0.5);
    });

    it("excludes paused time and continues with accumulated grind time", () => {
        const running = reduceSession(createSession(), { type: "start", now: 0 });
        const paused = reduceSession(running, { type: "pause", now: 1_800_000 });
        expect(calculateQuantityPerHour(25, getElapsedMs(paused, 3_600_000))).toBe(50);
        const resumed = reduceSession(paused, { type: "resume", now: 3_600_000 });
        expect(calculateQuantityPerHour(25, getElapsedMs(resumed, 5_400_000))).toBe(25);
    });
});
