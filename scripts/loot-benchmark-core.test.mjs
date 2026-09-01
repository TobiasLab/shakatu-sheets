import { describe, expect, it } from "vitest";
import {
    calibrateThreshold,
    chooseConsensus,
    chooseTemporalConsensus,
    chooseTemporalPairConsensus,
    compareDetectedEvents,
    compareEvents,
    parseItem,
    parseQuantity,
    rowBirthCount,
    selectOcrObservations,
    stackShifted,
    trackRowEvents,
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

describe("loot benchmark event tracking", () => {
    const distance = (left, right) => Math.abs((left ?? 0) - (right ?? 0));

    function row(count, fingerprints, scores = fingerprints.map(() => 300)) {
        return {
            count,
            strength: scores.reduce((total, score) => total + score, 0),
            fingerprint: fingerprints.at(-1),
            fingerprints,
            observations: fingerprints.map((fingerprint, index) => ({
                slot: 5 - count + index,
                centerY: 200 - (count - index - 1) * 40,
                score: scores[index],
                fingerprint,
            })),
        };
    }

    it("tracks baselines and multiple births in display order", () => {
        const tracks = trackRowEvents(
            [row(1, [1]), row(3, [1, 2, 3]), row(3, [1, 2, 3]), row(3, [1, 2, 3])],
            100,
            distance,
        );

        expect(tracks.map(({ firstFrame, baseline }) => ({ firstFrame, baseline }))).toEqual([
            { firstFrame: 0, baseline: true },
            { firstFrame: 1, baseline: false },
            { firstFrame: 1, baseline: false },
        ]);
        expect(tracks[1].observations[0].centerY).toBe(160);
        expect(tracks[2].observations[0].centerY).toBe(200);
    });

    it("preserves retained identities through a full-stack replacement", () => {
        const rows = [row(3, [1, 2, 3]), row(3, [2, 3, 4]), row(3, [2, 3, 4]), row(3, [2, 3, 4])];
        expect(rowBirthCount(rows[0], rows[1], rows[2], 100, distance)).toBe(1);

        const tracks = trackRowEvents(rows, 100, distance);
        expect(tracks.filter(({ baseline }) => !baseline).map(({ firstFrame }) => firstFrame)).toEqual([1]);
        expect(tracks[1].observations.map(({ fingerprint }) => fingerprint)).toEqual([2, 2, 2, 2]);
        expect(tracks.at(-1).observations.map(({ fingerprint }) => fingerprint)).toEqual([4, 4, 4]);
    });

    it("detects births that are hidden by simultaneous expirations", () => {
        const rows = [row(3, [1, 2, 3]), row(2, [3, 4]), row(2, [3, 4]), row(2, [3, 4])];
        expect(rowBirthCount(rows[0], rows[1], rows[2], 100, distance)).toBe(1);

        const tracks = trackRowEvents(rows, 100, distance);
        expect(tracks.filter(({ baseline }) => !baseline).map(({ firstFrame }) => firstFrame)).toEqual([1]);
        expect(tracks[2].observations.map(({ fingerprint }) => fingerprint)).toEqual([3, 3, 3, 3]);
        expect(tracks.at(-1).observations.map(({ fingerprint }) => fingerprint)).toEqual([4, 4, 4]);
    });

    it("supports multiple births in one replacement transition", () => {
        const rows = [row(3, [1, 2, 3]), row(3, [3, 4, 5]), row(3, [3, 4, 5]), row(3, [3, 4, 5])];
        expect(rowBirthCount(rows[0], rows[1], rows[2], 100, distance)).toBe(2);

        const tracks = trackRowEvents(rows, 100, distance);
        expect(tracks.filter(({ baseline }) => !baseline).map(({ firstFrame }) => firstFrame)).toEqual([1, 1]);
        expect(tracks.at(-2).observations.map(({ fingerprint }) => fingerprint)).toEqual([4, 4, 4]);
        expect(tracks.at(-1).observations.map(({ fingerprint }) => fingerprint)).toEqual([5, 5, 5]);
    });

    it("caps unanchored full-stack changes instead of inventing multiple births", () => {
        expect(rowBirthCount(row(2, [1, 2]), row(2, [3, 4]), row(2, [3, 4]), 100, distance)).toBe(1);
        expect(rowBirthCount(row(3, [1, 2, 3]), row(2, [4, 5]), row(2, [4, 5]), 100, distance)).toBe(0);
        expect(rowBirthCount(row(2, [1, 2]), row(3, [3, 4, 5]), row(3, [3, 4, 5]), 100, distance)).toBe(1);
    });

    it("does not invent births when identical rows fade from the top", () => {
        const previous = row(3, [1, 1, 1]);
        const current = row(2, [1.05, 1.05]);
        expect(rowBirthCount(previous, current, current, 100, distance)).toBe(0);
        expect(trackRowEvents([previous, current, current], 100, distance).filter(({ baseline }) => !baseline)).toEqual(
            [],
        );
    });

    it("does not treat an ambiguous repeated-row fade as a retained anchor", () => {
        const previous = row(3, [1, 1, 1]);
        const current = row(2, [1.05, 1.3]);
        expect(rowBirthCount(previous, current, current, 100, distance)).toBe(0);
    });

    it("enforces the absolute continuity threshold for retained anchors", () => {
        const previous = row(3, [1, 2, 3]);
        const next = row(2, [3.09, 4]);
        expect(rowBirthCount(previous, next, next, 100, distance)).toBe(1);

        const beyondThreshold = row(2, [3.11, 4]);
        expect(rowBirthCount(previous, beyondThreshold, beyondThreshold, 100, distance)).toBe(0);
    });

    it("rejects a transient count spike without stealing the retained identity", () => {
        const rows = [row(1, [1]), row(2, [1, 9]), row(1, [1]), row(1, [1]), row(1, [1])];
        const tracks = trackRowEvents(rows, 100, distance);

        expect(tracks.filter(({ baseline }) => !baseline)).toEqual([]);
        expect(tracks[0].observations.map(({ fingerprint }) => fingerprint)).toEqual([1, 1, 1, 1, 1]);
    });

    it("preserves a real event through an identical transient count spike", () => {
        const rows = [row(0, []), row(1, [1]), row(1, [1]), row(2, [1, 1]), row(1, [1]), row(1, [1])];
        const tracks = trackRowEvents(rows, 100, distance);
        const events = tracks.filter(({ baseline }) => !baseline);

        expect(events).toHaveLength(1);
        expect(events[0].observations.map(({ frame }) => frame)).toEqual([1, 2, 3, 4, 5]);
        expect(selectOcrObservations(events[0], 100).map(({ frame }) => frame)).toEqual([2, 3, 4]);
    });

    it("treats recovered rows above a retained baseline identity as baselines", () => {
        const rows = [row(1, [2]), row(2, [1, 2]), row(2, [1, 2]), row(2, [1, 2])];
        const tracks = trackRowEvents(rows, 100, distance);

        expect(tracks.filter(({ baseline }) => !baseline)).toEqual([]);
        expect(tracks[0].observations.map(({ fingerprint }) => fingerprint)).toEqual([2, 2, 2, 2]);
    });

    it("rejects an unconfirmed terminal-frame row", () => {
        const tracks = trackRowEvents([row(1, [1]), row(1, [1]), row(2, [1, 2])], 100, distance);
        expect(tracks.filter(({ baseline }) => !baseline)).toEqual([]);
    });

    it("preserves baseline identity through one empty detection frame", () => {
        const tracks = trackRowEvents([row(1, [1]), row(0, []), row(1, [1]), row(1, [1])], 100, distance);
        expect(tracks.filter(({ baseline }) => !baseline)).toEqual([]);
        expect(tracks).toHaveLength(1);
        expect(tracks[0].observations.map(({ frame }) => frame)).toEqual([0, 2, 3]);
    });

    it("preserves event identity through one empty detection frame", () => {
        const rows = [row(0, []), row(1, [1]), row(1, [1]), row(0, []), row(1, [1]), row(1, [1])];
        const events = trackRowEvents(rows, 100, distance).filter(({ baseline }) => !baseline);
        expect(events).toHaveLength(1);
        expect(events[0].observations.map(({ frame }) => frame)).toEqual([1, 2, 4, 5]);
    });

    it("detects a new bottom row while recovering from one empty frame", () => {
        const rows = [row(1, [1]), row(0, []), row(2, [1, 2]), row(2, [1, 2]), row(2, [1, 2])];
        const tracks = trackRowEvents(rows, 100, distance);
        const events = tracks.filter(({ baseline }) => !baseline);

        expect(events).toHaveLength(1);
        expect(tracks[0].observations.map(({ fingerprint }) => fingerprint)).toEqual([1, 1, 1, 1]);
        expect(events[0].observations.map(({ fingerprint }) => fingerprint)).toEqual([2, 2, 2]);
    });

    it("selects consecutive strong observations after the entrance frame", () => {
        const track = {
            firstFrame: 4,
            observations: [
                { frame: 4, score: 300 },
                { frame: 5, score: 90 },
                { frame: 6, score: 200 },
                { frame: 7, score: 210 },
                { frame: 8, score: 220 },
            ],
        };
        expect(selectOcrObservations(track, 100).map(({ frame }) => frame)).toEqual([6, 7, 8]);
    });

    it("matches simultaneous detections in their existing order", () => {
        const expected = [
            { id: "top", firstFrame: 5 },
            { id: "bottom", firstFrame: 5 },
        ];
        const actual = [
            { id: "detected-top", firstFrame: 5 },
            { id: "detected-bottom", firstFrame: 5 },
        ];
        expect(
            compareDetectedEvents(expected, actual).matches.map(({ expected, actual }) => [expected.id, actual.id]),
        ).toEqual([
            ["top", "detected-top"],
            ["bottom", "detected-bottom"],
        ]);
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

    it("does not combine item and quantity readings that never agreed", () => {
        expect(
            chooseTemporalPairConsensus([
                [{ item: "Black Stone", quantity: "1" }],
                [{ item: "Black Stone", quantity: "2" }],
                [{ item: "Ancient Spirit Dust", quantity: "1" }],
            ]),
        ).toEqual({ item: "", quantity: "" });
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
