import { describe, expect, it } from "vitest";
import { createEntry } from "../../domain/session";
import { aggregateDrops, formatOverlaySilver } from "./sessionOverlay";

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
});

describe("overlay silver formatting", () => {
    it.each([
        [300_990_000, "300.99M", "300.9M"],
        [-300_990_000, "-300.99M", "-300.9M"],
        [999_999, "999.99K", "999.9K"],
        [1_000_000, "1M", "1M"],
        [1_239_000_000, "1.23B", "1.2B"],
        [9_007_199_254_740_991, "9007.19T", "9007.1T"],
        [123, "123", "123"],
        [0, "0", "0"],
        [-0.001, "0", "0"],
    ])("keeps the unit and sign when shortening %s", (value, full, short) => {
        expect(formatOverlaySilver(value, 2)).toBe(full);
        expect(formatOverlaySilver(value, 1)).toBe(short);
    });
});
