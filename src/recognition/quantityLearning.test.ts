import { describe, expect, it } from "vitest";
import { copyLootReviewCapture, type LiveLootOcrFrame, type LootRoiFrame } from "./liveLoot";
import {
    correctionQuantityExample,
    type LearningProfile,
    prepareQuantityLearning,
    type QuantityExample,
    quantityImage,
    suggestUnresolvedQuantity,
} from "./quantityLearning";

const profile: LearningProfile = { font: "korean", uiScalePercent: 80, sourceWidth: 3440, sourceHeight: 1440 };
const six = [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."];
const nine = [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."];
function pixels(rows: string[], padding = 1, brightness = 255): LootRoiFrame {
    const width = rows[0].length + padding * 2,
        height = rows.length + padding * 2;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < rows.length; y++)
        for (let x = 0; x < rows[y].length; x++) {
            if (rows[y][x] === "#")
                data.fill(
                    brightness,
                    ((y + padding) * width + x + padding) * 4,
                    ((y + padding) * width + x + padding) * 4 + 3,
                );
        }
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width, height, pixels: data };
}
function example(id: string, quantity: number, validation = false): QuantityExample {
    const image = pixels(quantity === 6 ? six : nine, 1, 235 + (id.length % 20));
    return {
        ...image,
        pixels: Array.from(image.pixels),
        profile,
        id,
        quantity,
        originalQuantity: null,
        originalText: "Black Stone x &",
        confirmedAt: 1,
        validation,
    };
}
function model(autoAllow = false, extra: QuantityExample[] = []) {
    return prepareQuantityLearning({
        enabled: true,
        autoAllow,
        examples: [example("train-six-1", 6), example("train-six-2", 6), example("train-nine", 9), ...extra],
    });
}
const validation = [
    example("val-six-1", 6, true),
    example("val-six-2", 6, true),
    example("val-six-3", 6, true),
    example("val-nine", 9, true),
];
function frame(index: number, quantity = 6): LiveLootOcrFrame {
    const roi = pixels(quantity === 6 ? six : nine);
    return {
        frame: index,
        roi,
        observation: {
            slot: 0,
            centerY: 4,
            score: 100,
            fingerprint: {
                full: new Uint8Array(),
                quantity: new Uint8Array(),
                digits: { bounds: { left: 0, top: 0, right: roi.width, bottom: roi.height }, pixels: new Uint8Array() },
            },
        },
    };
}

describe("local quantity examples", () => {
    it("learns only explicit unresolved normal corrections with valid complete pixels", () => {
        const review = {
            id: 1,
            source: "normal" as const,
            accepted: false,
            error: "",
            learningId: "event-1",
            learningProfile: profile,
            result: {
                status: "withheld" as const,
                reason: "quantity-not-recognized" as const,
                eventId: "1",
                firstFrame: 0,
                selectedFrames: [0, 1, 2],
                itemName: null,
                quantity: null,
                capture: copyLootReviewCapture(frame(0)),
            },
        };
        expect(correctionQuantityExample(review, 6)?.quantity).toBe(6);
        expect(correctionQuantityExample({ ...review, accepted: true }, 6)).toBeUndefined();
        expect(correctionQuantityExample({ ...review, source: "rare" }, 6)).toBeUndefined();
        expect(
            correctionQuantityExample(
                {
                    ...review,
                    result: {
                        ...review.result,
                        status: "recognized",
                        reason: null,
                        itemName: "Black Stone",
                        quantity: 8,
                    },
                },
                6,
            ),
        ).toBeUndefined();
        expect(correctionQuantityExample(review, 1.5)).toBeUndefined();
        expect(
            correctionQuantityExample({ ...review, result: { ...review.result, capture: undefined } }, 6),
        ).toBeUndefined();
        review.result.capture.pixels.fill(0);
        expect(correctionQuantityExample(review, 6)).toBeUndefined();
    });
    it("matches whole shapes despite padding and fading, while isolating font, scale and resolution", () => {
        const reader = model();
        expect(reader.suggest(pixels(six, 3, 210), profile)).toEqual({ quantity: 6, automatic: false });
        expect(reader.suggest(pixels(nine), profile)?.quantity).toBe(9);
        for (const other of [
            { ...profile, font: "strong-sword" as const },
            { ...profile, uiScalePercent: 100 as const },
            { ...profile, sourceWidth: 2560 },
        ])
            expect(reader.suggest(pixels(six), other)).toBeUndefined();
        expect(reader.suggest(pixels(six.map((row) => `${row}..${row}`)), profile)).toBeUndefined();
        expect(reader.suggest(pixels([".....", "....."]), profile)).toBeUndefined();
    });
    it("abstains for conflicting labels and never trains from reserved validation images", () => {
        const wrong = { ...example("wrong", 6), quantity: 9 };
        expect(model(false, [wrong]).suggest(pixels(six), profile)).toBeUndefined();
        const onlyValidation = prepareQuantityLearning({ enabled: true, autoAllow: true, examples: validation });
        expect(onlyValidation.suggest(pixels(six), profile)).toBeUndefined();
        expect(
            prepareQuantityLearning({ enabled: false, autoAllow: true, examples: [example("six", 6)] }).suggest(
                pixels(six),
                profile,
            ),
        ).toBeUndefined();
    });
    it("requires reserved positive and competing examples before automatic eligibility", () => {
        expect(model(true).suggest(pixels(six), profile)?.automatic).toBe(false);
        expect(model(false, validation).suggest(pixels(six), profile)?.automatic).toBe(false);
        expect(model(true, validation.slice(0, 3)).suggest(pixels(six), profile)?.automatic).toBe(false);
        expect(model(true, validation).suggest(pixels(six), profile)?.automatic).toBe(true);
        expect(
            model(true, [...validation, { ...example("bad-validation", 6, true), quantity: 9 }]).suggest(
                pixels(six),
                profile,
            )?.automatic,
        ).toBe(false);
        const oneTraining = prepareQuantityLearning({
            enabled: true,
            autoAllow: true,
            examples: [example("six", 6), example("nine", 9), ...validation],
        });
        expect(oneTraining.suggest(pixels(six), profile)?.automatic).toBe(false);
    });
    it("copies quantity coordinates into the retained row and rejects partial or oversized crops", () => {
        const source = frame(0);
        const raw = { ...source, bounds: { left: 0, right: source.roi.width, top: 0, bottom: source.roi.height } };
        const capture = copyLootReviewCapture(raw);
        expect(quantityImage(capture)).toEqual(source.roi);
        expect(
            quantityImage({ ...capture, quantityBounds: { left: -1, top: 0, right: 2, bottom: 4 } }),
        ).toBeUndefined();
        expect(quantityImage(copyLootReviewCapture({ ...raw, bounds: { ...raw.bounds, top: 2 } }))).toBeUndefined();
        source.roi.pixels.fill(0);
        expect(quantityImage(capture)?.pixels.some((value) => value > 0)).toBe(true);
    });
});

describe("automatic unresolved quantity recovery", () => {
    const frames = [frame(0), frame(1), frame(2)];
    const readings = Array.from({ length: 3 }, () => ["Black Stone x &", "Black Stone x ?", "Black Stone x &"]);
    const reader = model(true, validation);
    it("requires clear matching items and at least three matching frame crops", () => {
        expect(suggestUnresolvedQuantity(frames, readings, ["Black Stone"], profile, reader)).toEqual({
            quantity: 6,
            itemName: "Black Stone",
            automatic: true,
        });
        expect(
            suggestUnresolvedQuantity(frames.slice(0, 2), readings.slice(0, 2), ["Black Stone"], profile, reader)
                ?.automatic,
        ).toBe(false);
        const missing = {
            ...frame(2),
            observation: {
                ...frame(2).observation,
                fingerprint: { full: new Uint8Array(), quantity: new Uint8Array() },
            },
        };
        expect(
            suggestUnresolvedQuantity([...frames.slice(0, 2), missing], readings, ["Black Stone"], profile, reader)
                ?.automatic,
        ).toBe(false);
        expect(
            suggestUnresolvedQuantity([frame(0), frame(1), frame(2, 9)], readings, ["Black Stone"], profile, reader),
        ).toBeUndefined();
    });
    it("never automatically ignores numeric conflicts, unknown items, or conflicting item passes", () => {
        for (const changed of ["Black Stone x 9", "Unknown item x &", "Caphras Stone x ?"]) {
            const conflict = [readings[0], readings[1], [changed, changed, changed]];
            expect(
                suggestUnresolvedQuantity(frames, conflict, ["Black Stone", "Caphras Stone"], profile, reader)
                    ?.automatic,
            ).toBe(false);
        }
        const minorityConflict = [
            readings[0],
            readings[1],
            ["Black Stone x &", "Black Stone x &", "Caphras Stone x ?"],
        ];
        expect(
            suggestUnresolvedQuantity(frames, minorityConflict, ["Black Stone", "Caphras Stone"], profile, reader)
                ?.automatic,
        ).toBe(false);
    });
});
