import { describe, expect, it } from "vitest";
import {
    detectGrindSpot,
    detectMarniLootSlots,
    parseMarniDuration,
    resolveMarniQuantity,
    selectMarniQuantity,
    trustedMarniQuantity,
} from "./marni";

describe("Marni screenshot metadata", () => {
    it("parses the tracker duration despite OCR spacing and punctuation", () => {
        expect(parseMarniDuration("Time: 1h 52 s")).toBe(3_652_000);
        expect(parseMarniDuration("Time: 1h52's")).toBe(3_652_000);
        expect(parseMarniDuration("Time: 1th 52 s")).toBe(3_652_000);
        expect(parseMarniDuration("Time: th 52 s")).toBe(3_652_000);
        expect(parseMarniDuration("Date: 2026-08-21")).toBeNull();
    });

    it("detects supported grind spots and preserves the selection when unreadable", () => {
        expect(detectGrindSpot("Monster Zone: Sycraia Ruins Lower Zone", "stars-end-revamp")).toBe(
            "sycraia-lower-revamp",
        );
        expect(detectGrindSpot("Monster Zone: Star's End", "sycraia-lower-revamp")).toBe("stars-end-revamp");
        expect(detectGrindSpot("Monster Zone: Zephyros Castle", "sycraia-lower-revamp")).toBe("zephyros-castle");
        expect(detectGrindSpot("Monster Zone: Zephyrus Castle", "sycraia-lower-revamp")).toBe("zephyros-castle");
        expect(detectGrindSpot("Monster Zone: Aphrodon Temple", "sycraia-lower-revamp")).toBe("aphrodon-temple");
        expect(detectGrindSpot("Monster Zone: Hermesia Inner Castle", "sycraia-lower-revamp")).toBe(
            "hermesia-inner-castle",
        );
        expect(detectGrindSpot("Monster Zone: Magaia Temple", "sycraia-lower-revamp")).toBe("magaia-temple");
        expect(detectGrindSpot("unreadable", "stars-end-revamp")).toBe("stars-end-revamp");
    });

    it("matches full catalog names before keyword guesses", () => {
        expect(detectGrindSpot("Monster Zone: Sycraia Ruins Upper Zone", "garmoth-202")).toBe("garmoth-202");
        expect(detectGrindSpot("Monster Zone: Sycraia Ruins Upper Zone", "sycraia-lower-revamp")).toBe("garmoth-202");
        expect(detectGrindSpot("Monster Zone: Dark Energy Floodlands (Zephyros)", "sycraia-lower-revamp")).toBe(
            "garmoth-210",
        );
        expect(detectGrindSpot("Start the legend now", "magaia-temple")).toBe("magaia-temple");
        expect(detectGrindSpot("Monster Zone: Stars End", "sycraia-lower-revamp")).toBe("stars-end-revamp");
    });

    it("leaves uncertain or invalid quantities for manual review", () => {
        expect(trustedMarniQuantity("20630")).toBe("20630");
        expect(trustedMarniQuantity("70")).toBe("70");
        expect(trustedMarniQuantity("99999999999999999999")).toBe("");
    });

    it("resolves the BDO five glyph when its upper stroke points left", () => {
        expect(resolveMarniQuantity("3", true)).toBe("5");
        expect(resolveMarniQuantity("3", false)).toBe("3");
        expect(resolveMarniQuantity("13", true)).toBe("13");
    });

    it("uses agreeing retry quantities and preserves uncertain disagreements", () => {
        expect(
            selectMarniQuantity([
                { quantity: "20630", confidence: 52 },
                { quantity: "20630", confidence: 64 },
                { quantity: "20830", confidence: 91 },
            ]),
        ).toEqual({ quantity: "20630", confidence: 70 });
        expect(
            selectMarniQuantity([
                { quantity: "20630", confidence: 52 },
                { quantity: "20830", confidence: 91 },
                { quantity: "20330", confidence: 88 },
            ]),
        ).toEqual({ quantity: "20630", confidence: 52 });
        expect(
            selectMarniQuantity([
                { quantity: "20630", confidence: 52 },
                { quantity: "20630", confidence: 64 },
                { quantity: "20830", confidence: 91 },
                { quantity: "20330", confidence: 88 },
                { quantity: "20680", confidence: 80 },
            ]),
        ).toEqual({ quantity: "20630", confidence: 52 });
    });

    it("finds occupied slot borders instead of assuming fixed crop coordinates", () => {
        for (const size of [36, 54]) {
            const width = 400;
            const height = 400;
            const pixels = new Uint8ClampedArray(width * height * 4);
            const drawSlot = (left: number, top: number) => {
                for (let offset = 0; offset < size; offset += 1) {
                    for (const [x, y] of [
                        [left + offset, top],
                        [left + offset, top + size - 1],
                        [left, top + offset],
                        [left + size - 1, top + offset],
                    ]) {
                        const pixel = (y * width + x) * 4;
                        pixels[pixel] = 100;
                        pixels[pixel + 1] = 100;
                        pixels[pixel + 2] = 100;
                        pixels[pixel + 3] = 255;
                    }
                }
            };
            const positions = [
                { x: 12, y: 270, size },
                { x: 18 + size, y: 270, size },
                { x: 12, y: 276 + size, size },
            ];
            for (const slot of positions) drawSlot(slot.x, slot.y);

            expect(detectMarniLootSlots(pixels, width, height)).toEqual(positions);
        }
    });
});
