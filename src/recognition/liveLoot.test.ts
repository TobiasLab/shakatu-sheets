import { describe, expect, it } from "vitest";
import {
    analyzeLootRoiFrame,
    type LootDetectedRows,
    type LootDetectionProfile,
    parseLootItem,
    parseLootQuantity,
    recognizeLootReplay,
    selectLootOcrObservations,
    trackLootRows,
} from "./liveLoot";

const distance = (left: number | undefined, right: number | undefined) => Math.abs((left ?? 0) - (right ?? 0));

function row(fingerprints: number[], scores = fingerprints.map(() => 300)): LootDetectedRows<number> {
    return {
        count: fingerprints.length,
        strength: scores.reduce((total, score) => total + score, 0),
        fingerprint: fingerprints[fingerprints.length - 1],
        fingerprints,
        observations: fingerprints.map((fingerprint, index) => ({
            slot: 5 - fingerprints.length + index,
            centerY: 200 - (fingerprints.length - index - 1) * 40,
            score: scores[index],
            fingerprint,
        })),
    };
}

describe("live loot ROI analysis", () => {
    const profile: LootDetectionProfile = {
        width: 100,
        height: 100,
        maxRows: 2,
        bottomCenter: 70,
        spacing: 30,
        rowThreshold: 5,
    };

    function frameWithBottomGlyphs() {
        const pixels = new Uint8ClampedArray(profile.width * profile.height * 4);
        for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
        for (let x = 28; x < 94; x += 4) {
            const offset = (profile.bottomCenter * profile.width + x) * 4;
            pixels.fill(255, offset, offset + 4);
        }
        return { width: profile.width, height: profile.height, pixels };
    }

    it("detects a contiguous bottom row from packed RGBA pixels", () => {
        const detected = analyzeLootRoiFrame(frameWithBottomGlyphs(), profile);

        expect(detected.count).toBe(1);
        expect(detected.observations).toHaveLength(1);
        expect(detected.observations[0]).toMatchObject({ slot: 1, centerY: 70 });
        expect(detected.observations[0].score).toBe(17);
        expect([...detected.observations[0].fingerprint.full].filter(Boolean)).toHaveLength(17);
        expect([...detected.observations[0].fingerprint.quantity].filter(Boolean)).toHaveLength(9);
    });

    it("rejects mismatched dimensions and malformed pixel buffers", () => {
        const frame = frameWithBottomGlyphs();
        expect(() => analyzeLootRoiFrame({ ...frame, width: 99 }, profile)).toThrow("100x100");
        expect(() => analyzeLootRoiFrame({ ...frame, pixels: frame.pixels.subarray(4) }, profile)).toThrow(
            "tightly packed",
        );
    });

    it("accepts detector geometry at the exact pixel-neighborhood boundaries", () => {
        const boundaryProfile = { ...profile, bottomCenter: 90, spacing: 81 };
        const pixels = new Uint8ClampedArray(profile.width * profile.height * 4);

        expect(() =>
            analyzeLootRoiFrame({ width: profile.width, height: profile.height, pixels }, boundaryProfile),
        ).not.toThrow();
    });
});

describe("live loot event tracking", () => {
    it("preserves baselines and detects multiple births in display order", () => {
        const tracks = trackLootRows([row([1]), row([1, 2, 3]), row([1, 2, 3]), row([1, 2, 3])], 100, distance);

        expect(tracks.map(({ firstFrame, baseline }) => ({ firstFrame, baseline }))).toEqual([
            { firstFrame: 0, baseline: true },
            { firstFrame: 1, baseline: false },
            { firstFrame: 1, baseline: false },
        ]);
    });

    it("preserves event identity through one empty detector frame", () => {
        const tracks = trackLootRows([row([]), row([1]), row([1]), row([]), row([1]), row([1])], 100, distance);
        const events = tracks.filter(({ baseline }) => !baseline);

        expect(events).toHaveLength(1);
        expect(events[0].observations.map(({ frame }) => frame)).toEqual([1, 2, 4, 5]);
    });

    it("selects three consecutive strong observations after the entrance frame", () => {
        const track = {
            id: "detected-0001",
            firstFrame: 4,
            baseline: false,
            observations: [
                { frame: 4, slot: 4, centerY: 200, score: 300, fingerprint: 1 },
                { frame: 5, slot: 4, centerY: 200, score: 90, fingerprint: 1 },
                { frame: 6, slot: 4, centerY: 200, score: 200, fingerprint: 1 },
                { frame: 7, slot: 4, centerY: 200, score: 210, fingerprint: 1 },
                { frame: 8, slot: 4, centerY: 200, score: 220, fingerprint: 1 },
            ],
        };

        expect(selectLootOcrObservations(track, 100).map(({ frame }) => frame)).toEqual([6, 7, 8]);
    });
});

describe("live loot replay recognition", () => {
    it("emits consecutive identical drops as distinct recognized events", async () => {
        const rows = [row([]), row([1]), row([1]), row([1, 1]), row([1, 1]), row([1, 1]), row([1, 1])];
        const results = await recognizeLootReplay({
            rows,
            rowThreshold: 100,
            distance,
            dictionary: ["Black Stone"],
            readText: async () => [["Black Stone x 2", "noise"], ["Black Stone x2"], ["Black Stone x 2"]],
        });

        expect(results).toEqual([
            {
                eventId: "detected-0001",
                firstFrame: 1,
                selectedFrames: [2, 3, 4],
                itemName: "Black Stone",
                quantity: 2,
            },
            {
                eventId: "detected-0002",
                firstFrame: 3,
                selectedFrames: [4, 5, 6],
                itemName: "Black Stone",
                quantity: 2,
            },
        ]);
    });

    it("withholds conflicting readings rather than combining item and quantity", async () => {
        const results = await recognizeLootReplay({
            rows: [row([]), row([1]), row([1]), row([1]), row([1])],
            rowThreshold: 100,
            distance,
            dictionary: ["Black Stone", "Ancient Spirit Dust"],
            readText: async () => [["Black Stone x 1"], ["Black Stone x 2"], ["Ancient Spirit Dust x 1"]],
        });

        expect(results[0]).toMatchObject({ itemName: null, quantity: null });
    });

    it("parses OCR spacing and common single-one glyph substitutions", () => {
        expect(parseLootItem("Black Stone x2", ["Black Stone"])).toBe("Black Stone");
        expect(parseLootQuantity("Black Stone x I")).toBe(1);
        expect(parseLootQuantity("Black Stone x0")).toBeNull();
    });
});
