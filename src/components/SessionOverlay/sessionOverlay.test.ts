import { describe, expect, it } from "vitest";
import { createEntry } from "../../domain/session";
import { aggregateDrops } from "./sessionOverlay";

describe("overlay drops", () => {
    it("combines quantities across prices and sources while excluding expenses", () => {
        const entries = [
            createEntry("Black Stone", 2, 100, "market"),
            { ...createEntry("Black Stone", 3, 200, "market"), source: "recognition" as const },
            createEntry("Trash loot", 15000, 10, "vendor"),
            createEntry("Black Stone", 1, 100, "expense"),
        ];
        expect(aggregateDrops(entries)).toEqual([
            { name: "Black Stone", quantity: 5 },
            { name: "Trash loot", quantity: 15000 },
        ]);
        expect(entries[0].quantity).toBe(2);
    });
    it("clears icons when the session has no drops", () => {
        expect(aggregateDrops([])).toEqual([]);
        expect(aggregateDrops([createEntry("Buff", 1, 100, "expense")])).toEqual([]);
    });
});
