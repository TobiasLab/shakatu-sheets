import { describe, expect, it } from "vitest";
import { parseConsumablePresetExport } from "./consumablePreset";

describe("Garmoth consumable preset export", () => {
    it("preserves the exported IDs without inventing quantities or prices", () => {
        expect(
            parseConsumablePresetExport(
                JSON.stringify({
                    name: "Cheapo123",
                    export: "99999900,9692,1411,1407,761879,767969,100001510",
                }),
            ),
        ).toEqual({
            name: "Cheapo123",
            itemIds: [99999900, 9692, 1411, 1407, 761879, 767969, 100001510],
        });
    });

    it("accepts whitespace and unknown positive IDs", () => {
        expect(parseConsumablePresetExport('{"name":" Custom ","export":" 42, 123 "}')).toEqual({
            name: "Custom",
            itemIds: [42, 123],
        });
    });

    it.each([
        "",
        "no JSON",
        "null",
        "[]",
        "{}",
        '{"name":"x","export":[1]}',
        '{"name":" ","export":"1"}',
        '{"name":"x","export":""}',
    ])("rejects malformed exports: %s", (text) => {
        expect(() => parseConsumablePresetExport(text)).toThrow();
    });

    it.each(["0", "-1", "1.5", "1e3", "1,", "1,,2", "1,01", "9007199254740992", "Infinity"])(
        "rejects invalid or duplicate identifiers: %s",
        (ids) => {
            expect(() => parseConsumablePresetExport(JSON.stringify({ name: "x", export: ids }))).toThrow();
        },
    );

    it("bounds names, item counts, and input size", () => {
        for (const text of [
            JSON.stringify({ name: "x".repeat(101), export: "1" }),
            JSON.stringify({ name: "x", export: Array.from({ length: 101 }, (_, i) => i + 1).join(",") }),
            " ".repeat(16_385),
        ])
            expect(() => parseConsumablePresetExport(text)).toThrow();
    });
});
