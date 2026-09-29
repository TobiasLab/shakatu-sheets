import { expect, test } from "vitest";
import { quantityImage } from "../src/recognition/quantityLearning.ts";
import { createLearningReplay, learningFrame } from "./loot-learning-replay.mjs";

const profile = { font: "korean", uiScalePercent: 80, sourceWidth: 3440, sourceHeight: 1440 };
const dictionary = ["Black Stone", "Caphras Stone"];
const glyphs = {
    6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
    9: [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
    "Black Stone": [
        "#.#.#.#.#.#.",
        "############",
        "#..........#",
        "############",
        "#.#.#.#.#.#.",
        "#..........#",
        "############",
    ],
    "Caphras Stone": [
        "############",
        "#..........#",
        "#.########.#",
        "#.#......#.#",
        "#.########.#",
        "#..........#",
        "############",
    ],
};
const itemBounds = { left: 2, right: 16, top: 20, bottom: 29 };
const quantityBounds = { left: 20, right: 27, top: 20, bottom: 29 };

/** A 40 × 40 ROI with the item and quantity text on one row; `noise` changes only dark pixels. */
function frame(index, itemName, quantity, noise) {
    const width = 40;
    const pixels = new Uint8ClampedArray(width * 40 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels.fill((offset / 4 + noise) % 50, offset, offset + 3);
        pixels[offset + 3] = 255;
    }
    function draw(rows, left) {
        for (let y = 0; y < rows.length; y++)
            for (let x = 0; x < rows[y].length; x++)
                if (rows[y][x] === "#")
                    pixels.fill(240, ((21 + y) * width + left + x) * 4, ((21 + y) * width + left + x) * 4 + 3);
    }
    draw(glyphs[itemName], itemBounds.left + 1);
    draw(glyphs[quantity], quantityBounds.left + 1);
    return {
        eventId: `event-${noise}`,
        frame: index,
        roi: { width, height: 40, pixels },
        observation: {
            slot: 0,
            centerY: 24,
            score: 100,
            fingerprint: {
                full: new Uint8Array(),
                quantity: new Uint8Array(),
                digits: { bounds: quantityBounds, itemBounds, pixels: new Uint8Array() },
            },
        },
        diagnostics: { passes: [] },
    };
}

function observed(itemName, quantity, noise) {
    return [0, 1, 2].map((index) =>
        learningFrame(frame(index, itemName, quantity, noise), Array(3).fill(`${itemName} x ${quantity}`)),
    );
}

const recognized = (itemName, quantity) => ({ status: "recognized", reason: null, itemName, quantity });

test("learning frames keep only the text band with shifted bounds", () => {
    const full = frame(0, "Black Stone", 6, 1);
    const band = learningFrame(full, []).frame;
    expect(band.roi.height).toBe(9);
    const crop = (entry) =>
        quantityImage({ ...entry.roi, quantityBounds: entry.observation.fingerprint.digits.bounds });
    expect(crop(band)).toEqual(crop(full));
});

test("the replay scores prefills and automatic recovery before each event teaches the library", () => {
    const replay = createLearningReplay(profile, dictionary);
    for (let event = 0; event < 24; event++) {
        const [itemName, quantity] = event % 2 === 0 ? ["Black Stone", 6] : ["Caphras Stone", 9];
        replay.event(recognized(itemName, quantity), observed(itemName, quantity, event), event);
    }
    const report = replay.report();
    expect(report.taught).toBe(24);
    expect(report.prefill.quantity.wrong).toBe(0);
    expect(report.prefill.item.wrong).toBe(0);
    expect(report.prefill.quantity.correct).toBeGreaterThan(0);
    expect(report.firstEligibleEvent).not.toBeNull();
    expect(report.automatic).toMatchObject({ wrong: 0 });
    expect(report.automatic.correct).toBeGreaterThan(0);
});

test("the replay follows storage deduplication and conflict rules and lists unresolved events", () => {
    const replay = createLearningReplay(profile, dictionary);
    replay.event(recognized("Black Stone", 6), observed("Black Stone", 6, 1), 1);
    replay.event(recognized("Black Stone", 6), observed("Black Stone", 6, 1), 2);
    replay.event(recognized("Black Stone", 9), observed("Black Stone", 6, 1), 3);
    replay.event({ status: "withheld", reason: "consensus-withheld" }, observed("Black Stone", 6, 4), 4);
    const report = replay.report();
    expect(report).toMatchObject({ taught: 1, duplicates: 1, conflicts: 1 });
    expect(report.unresolved).toEqual([
        expect.objectContaining({ firstBatchId: 4, prefill: { itemName: "Black Stone", quantity: 6 } }),
    ]);
});
