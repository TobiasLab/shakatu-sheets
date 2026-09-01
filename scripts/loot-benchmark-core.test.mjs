import { describe, expect, it } from "vitest";
import {
    calibrateThreshold,
    chooseConsensus,
    chooseTemporalConsensus,
    compareEvents,
    parseItem,
    parseQuantity,
    stackShifted,
    validateGeneratedManifest,
} from "./loot-benchmark-core.mjs";

function generatedManifest(events = []) {
    return {
        sampleFps: 8,
        maxRows: 5,
        itemDictionary: ["Black Stone", "Ancient Spirit Dust"],
        roi: { pixels: { width: 360, height: 310 } },
        segments: [
            {
                id: "development-segment",
                split: "development",
                frameCount: 80,
                directory: "development-segment",
                framePattern: "frame-%06d.png",
                events,
            },
        ],
    };
}

const event = {
    id: "black-stone-001",
    item: "Black Stone",
    quantity: 2,
    firstFrame: 10,
    stableFrame: 12,
    lastFrame: 40,
};

describe("loot benchmark calibration", () => {
    it("can classify every calibration example as empty", () => {
        expect(
            calibrateThreshold([
                { score: 0, occupied: false },
                { score: 3, occupied: false },
            ]),
        ).toEqual({ threshold: 4, errors: 0 });
    });

    it("matches adjacent events chronologically", () => {
        expect(compareEvents([2, 3], [1, 2])).toEqual({
            matches: [
                { expected: 2, actual: 1 },
                { expected: 3, actual: 2 },
            ],
            missed: [],
            invented: [],
        });
    });

    it("detects an upward stack shift when the bottom row is unchanged", () => {
        const distance = (left, right) => Math.abs(left - right);
        expect(stackShifted([1, 2, 3], [2, 3, 3], distance)).toBe(true);
        expect(stackShifted([1, 2, 3], [1, 2, 3], distance)).toBe(false);
    });
});

describe("loot benchmark OCR parsing", () => {
    it("parses item names when OCR omits the quantity space", () => {
        expect(parseItem("Black Stone x2", ["Black Stone"])).toBe("Black Stone");
        expect(parseQuantity("Black Stone x2")).toBe("2");
        expect(parseQuantity("Black Stone x0")).toBe("");
    });

    it("withholds equidistant dictionary matches and tied consensus", () => {
        expect(parseItem("Hat x 1", ["Cat", "Bat"])).toBe("");
        expect(chooseConsensus(["Cat", "Bat", "Cat", "Bat"])).toBe("");
    });

    it("requires OCR support from at least two frames", () => {
        expect(chooseTemporalConsensus([["Black Stone", "Black Stone", "Black Stone"], [], []])).toBe("");
        expect(chooseTemporalConsensus([["Black Stone"], ["Black Stone"], []])).toBe("Black Stone");
    });
});

describe("generated loot manifest validation", () => {
    it("accepts omitted events when another development segment is annotated", () => {
        const manifest = generatedManifest([event]);
        manifest.segments.push({
            id: "empty-test-segment",
            split: "test",
            frameCount: 20,
            directory: "empty-test-segment",
            framePattern: "frame-%06d.png",
        });
        expect(() => validateGeneratedManifest(manifest, { requireItemDictionary: true })).not.toThrow();
    });

    it("rejects out-of-order and out-of-range generated annotations", () => {
        expect(() =>
            validateGeneratedManifest(generatedManifest([{ ...event, lastFrame: 80 }]), {
                requireItemDictionary: true,
            }),
        ).toThrow("frame bounds are invalid");
        expect(() =>
            validateGeneratedManifest(
                generatedManifest([event, { ...event, id: "black-stone-002", firstFrame: 5, stableFrame: 6 }]),
                { requireItemDictionary: true },
            ),
        ).toThrow("events must be ordered");
        expect(() =>
            validateGeneratedManifest(generatedManifest([{ ...event, stableFrame: 39 }]), {
                requireItemDictionary: true,
            }),
        ).toThrow("frame bounds are invalid");
    });

    it("rejects normalized dictionary duplicates", () => {
        const manifest = generatedManifest([event]);
        manifest.itemDictionary = ["Black Stone", "black-stone"];
        expect(() => validateGeneratedManifest(manifest, { requireItemDictionary: true })).toThrow("unique item names");
    });

    it("rejects annotations with too many simultaneous rows", () => {
        const events = Array.from({ length: 6 }, (_, index) => ({
            ...event,
            id: `black-stone-${index}`,
        }));
        expect(() => validateGeneratedManifest(generatedManifest(events))).toThrow("exceed maxRows");
    });
});
