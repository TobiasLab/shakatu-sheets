import { describe, expect, it } from "vitest";
import { copyLootReviewCapture, type LiveLootOcrFrame, type LootRoiFrame } from "./liveLoot";
import {
    correctionQuantityExample,
    itemImage,
    type LearningProfile,
    learnableImages,
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
    for (let i = 0; i < Math.min(id.length, image.width * 3); i++)
        image.pixels[Math.floor(i / 3) * 4 + (i % 3)] = id.charCodeAt(i) % 90;
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
        expect(correctionQuantityExample(review, 6, "Black Stone")).toMatchObject({
            quantity: 6,
            audit: {
                version: 1,
                eventId: "1",
                status: "withheld",
                reason: "quantity-not-recognized",
                cropFrame: { frame: 0 },
                frames: [],
            },
        });
        expect(correctionQuantityExample({ ...review, accepted: true }, 6, "Black Stone")).toBeUndefined();
        expect(correctionQuantityExample({ ...review, source: "rare" }, 6, "Black Stone")).toBeUndefined();
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
                "Black Stone",
            ),
        ).toBeUndefined();
        expect(correctionQuantityExample(review, 1.5, "Black Stone")).toBeUndefined();
        expect(
            correctionQuantityExample(
                { ...review, result: { ...review.result, capture: undefined } },
                6,
                "Black Stone",
            ),
        ).toBeUndefined();
        review.result.capture.pixels.fill(0);
        expect(correctionQuantityExample(review, 6, "Black Stone")).toBeUndefined();
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

function namedExample(id: string, itemName = "Black Stone", quantity = 6, reserved = false): QuantityExample {
    const number = example(id, quantity, reserved);
    const name = pixels((itemName === "Black Stone" ? six : nine).map((row) => `${row}..${row}..${row}`));
    for (let i = 0; i < id.length; i++) name.pixels[i * 4] = id.charCodeAt(i) % 90;
    return { ...number, itemName, itemImage: { ...name, pixels: Array.from(name.pixels) } };
}
function namedFrame(index: number, quantity = 6): LiveLootOcrFrame {
    const number = frame(index, quantity);
    const name = pixels(six.map((row) => `${row}..${row}..${row}`));
    const width = name.width + 4 + number.roi.width;
    const data = new Uint8ClampedArray(width * name.height * 4);
    for (let y = 0; y < name.height; y++) {
        data.set(name.pixels.subarray(y * name.width * 4, (y + 1) * name.width * 4), y * width * 4);
        data.set(
            number.roi.pixels.subarray(y * number.roi.width * 4, (y + 1) * number.roi.width * 4),
            (y * width + name.width + 4) * 4,
        );
    }
    return {
        ...number,
        roi: { width, height: name.height, pixels: data },
        observation: {
            ...number.observation,
            fingerprint: {
                ...number.observation.fingerprint,
                digits: {
                    pixels: new Uint8Array(),
                    bounds: { left: name.width + 4, right: width, top: 0, bottom: name.height },
                    itemBounds: { left: 0, right: name.width, top: 0, bottom: name.height },
                },
            },
        },
    };
}
function namedModel(autoAllow = true) {
    return prepareQuantityLearning({
        enabled: true,
        autoAllow,
        examples: [
            namedExample("train-a"),
            namedExample("train-b"),
            namedExample("train-c", "Caphras Stone", 9),
            namedExample("check-a", "Black Stone", 6, true),
            namedExample("check-b", "Black Stone", 6, true),
            namedExample("check-c", "Black Stone", 6, true),
            namedExample("check-d", "Caphras Stone", 9, true),
        ],
    });
}

describe("learned item names", () => {
    const dictionary = ["Black Stone", "Caphras Stone"];
    const frames = [namedFrame(0), namedFrame(1), namedFrame(2)];
    it("saves the confirmed item and separate image with original frame bounds", () => {
        const capture = copyLootReviewCapture(frames[0]);
        const saved = correctionQuantityExample(
            {
                id: 1,
                source: "normal",
                accepted: false,
                error: "",
                learningId: "item-event",
                learningProfile: profile,
                result: {
                    eventId: "1",
                    firstFrame: 0,
                    selectedFrames: [0],
                    status: "withheld",
                    reason: "item-not-recognized",
                    itemName: null,
                    quantity: null,
                    capture,
                },
            },
            6,
            "Black Stone",
        );
        expect(saved).toMatchObject({
            itemName: "Black Stone",
            itemImage: { width: 21, height: 9 },
            quantity: 6,
            audit: { cropFrame: { itemBounds: { left: 0, right: 21 } } },
        });
        expect(itemImage(capture)?.width).toBe(21);
        expect(itemImage({ ...capture, itemBounds: { left: -1, right: 21, top: 0, bottom: 9 } })).toBeUndefined();
    });
    it("previews exactly the crops that a correction would save", () => {
        const capture = copyLootReviewCapture(frames[0]);
        const blank = copyLootReviewCapture(frames[0]);
        blank.pixels.fill(0);
        for (const candidate of [capture, { ...capture, itemBounds: undefined }, blank]) {
            const saved = correctionQuantityExample(
                {
                    id: 1,
                    source: "normal",
                    accepted: false,
                    error: "",
                    learningId: "preview-event",
                    learningProfile: profile,
                    result: {
                        eventId: "1",
                        firstFrame: 0,
                        selectedFrames: [0],
                        status: "withheld",
                        reason: "item-not-recognized",
                        itemName: null,
                        quantity: null,
                        capture: candidate,
                    },
                },
                6,
                "Black Stone",
            );
            const preview = learnableImages(candidate);
            expect(preview === undefined).toBe(saved === undefined);
            expect(preview?.item === undefined).toBe(!saved?.itemImage);
        }
        expect(learnableImages(capture)?.item?.width).toBe(21);
        expect(learnableImages({ ...capture, itemBounds: undefined })).toMatchObject({ item: undefined });
        expect(learnableImages(blank)).toBeUndefined();
    });
    it("learns the item independently of quantity and the current dictionary limits suggestions", () => {
        const reader = namedModel(false);
        const changedQuantity = copyLootReviewCapture(namedFrame(0, 9));
        const image = itemImage(changedQuantity);
        if (!image) throw Error("Expected item image");
        expect(reader.suggestItem(image, profile, dictionary)).toEqual({ itemName: "Black Stone", automatic: false });
        expect(reader.suggestItem(image, profile, ["Caphras Stone"])).toBeUndefined();
        expect(reader.suggestItem(image, { ...profile, font: "strong-sword" }, dictionary)).toBeUndefined();
        expect(reader.evidence.find((entry) => entry.kind === "item" && entry.label === "Black Stone")).toMatchObject({
            templates: 2,
            checked: 3,
            correct: 3,
            alternativesCorrect: 1,
            wrong: 0,
            eligible: true,
        });
    });
    it("recovers both fields when OCR cannot recognize either, but still requires confirmation by default", () => {
        const readings = frames.map(() => ["Unreadable x &", "Unreadable x ?"]);
        expect(suggestUnresolvedQuantity(frames, readings, dictionary, profile, namedModel())).toEqual({
            quantity: 6,
            itemName: "Black Stone",
            automatic: true,
        });
        expect(suggestUnresolvedQuantity(frames, readings, dictionary, profile, namedModel(false))?.automatic).toBe(
            false,
        );
        expect(
            suggestUnresolvedQuantity(frames.slice(0, 2), readings.slice(0, 2), dictionary, profile, namedModel())
                ?.automatic,
        ).toBe(false);
    });
    it("can recover an unreadable item with a clear OCR quantity that has no learned image match", () => {
        const noNumber = frames.map((value) => ({ ...value, roi: { ...value.roi, pixels: value.roi.pixels.slice() } }));
        for (const value of noNumber) {
            const bounds = value.observation.fingerprint.digits?.bounds;
            if (!bounds) throw Error("Expected quantity bounds");
            for (let y = 0; y < value.roi.height; y++)
                value.roi.pixels.fill(
                    0,
                    (y * value.roi.width + bounds.left) * 4,
                    (y * value.roi.width + bounds.right) * 4,
                );
        }
        const readings = frames.map(() => ["Unreadable x 42", "Unreadable x 42", "Unreadable x &"]);
        expect(suggestUnresolvedQuantity(noNumber, readings, dictionary, profile, namedModel())).toEqual({
            quantity: 42,
            itemName: "Black Stone",
            automatic: true,
        });
        expect(
            suggestUnresolvedQuantity(
                noNumber,
                frames.map(() => ["Unreadable x &"]),
                dictionary,
                profile,
                namedModel(),
            ),
        ).toEqual({ quantity: null, itemName: "Black Stone", automatic: false });
    });
    it("vetoes conflicting OCR, ambiguous item images and missing frame matches", () => {
        for (const text of ["Caphras Stone x &", "Unreadable x 9"]) {
            const readings = [["Unreadable x &"], ["Unreadable x &"], ["Unreadable x &", "Unreadable x &", text]];
            expect(suggestUnresolvedQuantity(frames, readings, dictionary, profile, namedModel())?.automatic).toBe(
                false,
            );
        }
        const reader = prepareQuantityLearning({
            enabled: true,
            autoAllow: true,
            examples: [namedExample("a"), { ...namedExample("b"), itemName: "Caphras Stone" }],
        });
        const image = itemImage(copyLootReviewCapture(frames[0]));
        if (!image) throw Error("Expected item image");
        expect(reader.suggestItem(image, profile, dictionary)).toBeUndefined();
        const digits = frames[2].observation.fingerprint.digits;
        if (!digits) throw Error("Expected quantity bounds");
        const missing = {
            ...frames[2],
            observation: {
                ...frames[2].observation,
                fingerprint: {
                    ...frames[2].observation.fingerprint,
                    digits: { ...digits, itemBounds: undefined },
                },
            },
        };
        expect(
            suggestUnresolvedQuantity(
                [frames[0], frames[1], missing],
                frames.map(() => ["Unreadable x &"]),
                dictionary,
                profile,
                namedModel(),
            )?.automatic,
        ).toBe(false);
    });
    it("vetoes raw OCR conflicts even when later passes replace the returned readings", () => {
        const readings = frames.map(() => ["Unreadable x &", "Unreadable x &", "Unreadable x &"]);
        for (const pass of [
            { region: "line" as const, text: "Caphras Stone x &" },
            { region: "line" as const, text: "Unreadable x 9" },
            { region: "quantity" as const, text: "9" },
        ]) {
            const rawConflict = frames.map((frame, index) => ({
                ...frame,
                diagnostics: { passes: index === 0 ? [{ ...pass, threshold: 150 as const, scale: 2 as const }] : [] },
            }));
            expect(suggestUnresolvedQuantity(rawConflict, readings, dictionary, profile, namedModel())).toEqual({
                quantity: 6,
                itemName: "Black Stone",
                automatic: false,
            });
        }
        const agreeing = frames.map((frame) => ({
            ...frame,
            diagnostics: {
                passes: [{ region: "quantity" as const, text: "6", threshold: 150 as const, scale: 4 as const }],
            },
        }));
        expect(suggestUnresolvedQuantity(agreeing, readings, dictionary, profile, namedModel())?.automatic).toBe(true);
    });
    it.each([true, false])("preserves the first component role despite clock changes (reserved: %s)", (reserved) => {
        const original = { ...namedExample("original", "Black Stone", 6, reserved), confirmedAt: 100 };
        const copy = {
            ...namedExample("copy", "Black Stone", 6, !reserved),
            itemImage: original.itemImage,
            confirmedAt: 1,
        };
        // The database returns descending insertion sequence, regardless of confirmation time.
        const reader = prepareQuantityLearning({ enabled: true, autoAllow: true, examples: [copy, original] });
        expect(reader.evidence.find((entry) => entry.kind === "item")).toMatchObject({
            templates: reserved ? 0 : 1,
            checked: reserved ? 1 : 0,
            eligible: false,
        });
    });
    it("does not count repeated component images as support or leak them into validation", () => {
        const first = { ...namedExample("first"), confirmedAt: 1 };
        const repeated = [2, 3, 4, 5].map((index) => ({
            ...namedExample(`copy-${index}`, "Black Stone", 6, index >= 3),
            itemImage: first.itemImage,
            confirmedAt: index,
        }));
        const reader = prepareQuantityLearning({
            enabled: true,
            autoAllow: true,
            examples: [...repeated.reverse(), first],
        });
        expect(reader.evidence.find((entry) => entry.kind === "item")).toMatchObject({
            templates: 1,
            checked: 0,
            eligible: false,
        });
    });
});
