import { describe, expect, it, vi } from "vitest";
import {
    LiveLootCoordinator,
    type LiveLootOcrReader,
    type LiveLootRecognitionResult,
    type LootOcrBounds,
    type LootRoiFrame,
} from "./liveLoot";
import { RARE_LOOT_OCR_BOUNDS, RARE_LOOT_OCR_SELECTION, RARE_LOOT_PROFILE, RareLootFrameAnalyzer } from "./rareLoot";

const SHELL_PIXELS = (370 - 65) * (80 - 35);

function rareFrame(shellRatio = 0): LootRoiFrame {
    const pixels = new Uint8ClampedArray(400 * 100 * 4);
    let remaining = Math.ceil(SHELL_PIXELS * shellRatio);
    for (let y = 35; y < 80 && remaining > 0; y += 1) {
        for (let x = 65; x < 370 && remaining > 0; x += 1) {
            const offset = (y * 400 + x) * 4;
            pixels.set([180, 120, 40, 255], offset);
            remaining -= 1;
        }
    }
    return { width: 400, height: 100, pixels };
}

function counts(ratios: number[]) {
    const analyzer = new RareLootFrameAnalyzer();
    return ratios.map((ratio) => analyzer.pushFrame(rareFrame(ratio)).count);
}

describe("rare loot frame analysis", () => {
    it("rejects sustained gold scenery without a horizontal banner edge", () => {
        const frame = rareFrame();
        for (let offset = 0; offset < frame.pixels.length; offset += 4) frame.pixels.set([180, 120, 40, 255], offset);
        const analyzer = new RareLootFrameAnalyzer();
        analyzer.pushFrame(rareFrame());
        for (let index = 0; index < 40; index += 1) expect(analyzer.pushFrame(frame).count).toBe(0);
    });

    it("rejects malformed frame dimensions and buffers", () => {
        const analyzer = new RareLootFrameAnalyzer();
        expect(() => analyzer.pushFrame({ ...rareFrame(), width: 399 })).toThrow("400x100");
        expect(() => analyzer.pushFrame({ ...rareFrame(), pixels: new Uint8ClampedArray(4) })).toThrow("RGBA");
    });

    it("rejects shell flashes shorter than four frames", () => {
        expect(counts([0, 0.7, 0.7, 0.7, 0])).toEqual([0, 0, 0, 0, 0]);
    });

    it("confirms four shell frames and emits at least 18 active observations", () => {
        const result = counts([0, 0.7, 0.7, 0.7, 0.7, ...Array.from({ length: 18 }, () => 0)]);
        expect(result.slice(0, 4)).toEqual([0, 0, 0, 0]);
        expect(result.slice(4, 22)).toEqual(Array.from({ length: 18 }, () => 1));
        expect(result[22]).toBe(0);
    });

    it("suppresses a banner whose confirmation begins in the baseline frame", () => {
        expect(counts([...Array.from({ length: 4 }, () => 0.7), ...Array.from({ length: 20 }, () => 0)])).toEqual(
            Array.from({ length: 24 }, () => 0),
        );
    });

    it("emits separate appearances after the first event ends", () => {
        const result = counts([
            0,
            ...Array.from({ length: 4 }, () => 0.7),
            ...Array.from({ length: 20 }, () => 0),
            ...Array.from({ length: 4 }, () => 0.7),
        ]);
        expect(result.filter((count, index) => count === 1 && result[index - 1] === 0)).toHaveLength(2);
    });

    it("separates a new shell after an early empty gap", () => {
        const result = counts([
            0,
            ...Array.from({ length: 4 }, () => 0.7),
            ...Array.from({ length: 6 }, () => 0),
            ...Array.from({ length: 4 }, () => 0.7),
            0,
            0,
        ]);
        expect(result.filter((count, index) => count === 1 && result[index - 1] === 0)).toHaveLength(2);
    });

    it.each([1, 2, 3])("does not split an active event for a %i-frame returning flash", (flashFrames) => {
        const analyzer = new RareLootFrameAnalyzer();
        const ratios = [
            0,
            ...Array.from({ length: 4 }, () => 0.7),
            ...Array.from({ length: 6 }, () => 0),
            ...Array.from({ length: flashFrames }, () => 0.7),
            0,
        ];
        const result = ratios.map((ratio) => analyzer.pushFrame(rareFrame(ratio)));
        expect(result.filter(({ count }, index) => count === 1 && result[index - 1]?.count === 0)).toHaveLength(1);
        expect(result.slice(11, 11 + flashFrames).map(({ observations }) => observations[0]?.score)).toEqual(
            Array.from({ length: flashFrames }, () => 0),
        );
        expect(result[result.length - 1]?.observations[0]?.score).toBe(1);
    });

    it("recognizes a new shell shortly after a suppressed baseline banner", () => {
        const result = counts([
            ...Array.from({ length: 4 }, () => 0.7),
            ...Array.from({ length: 6 }, () => 0),
            ...Array.from({ length: 4 }, () => 0.7),
            0,
            0,
        ]);
        expect(result.filter((count, index) => count === 1 && result[index - 1] === 0)).toHaveLength(1);
    });

    it("does not attribute confirmed replacement frames to the previous event", async () => {
        const analyzer = new RareLootFrameAnalyzer();
        const results: LiveLootRecognitionResult[] = [];
        const readText = vi.fn<LiveLootOcrReader>(async (frames) => frames.map(() => ["Deboreka Necklace x 1"]));
        const coordinator = new LiveLootCoordinator({
            profile: RARE_LOOT_PROFILE,
            dictionary: ["Twilight of the End - Earring", "Deboreka Necklace"],
            analyzeFrame: (frame) => analyzer.pushFrame(frame),
            ocrSelection: RARE_LOOT_OCR_SELECTION,
            ocrBounds: RARE_LOOT_OCR_BOUNDS,
            eventIdPrefix: "rare",
            readText,
            onResult: (result) => results.push(result),
        });

        for (const ratio of [
            0,
            ...Array.from({ length: 4 }, () => 0.7),
            ...Array.from({ length: 11 }, () => 0),
            ...Array.from({ length: 4 }, () => 0.7),
            ...Array.from({ length: 20 }, () => 0),
        ]) {
            coordinator.pushFrame(rareFrame(ratio));
        }
        await coordinator.finish();

        expect(readText).toHaveBeenCalledOnce();
        expect(results).toEqual([
            expect.objectContaining({ eventId: "rare-0001", status: "withheld", reason: "insufficient-observations" }),
            expect.objectContaining({
                eventId: "rare-0002",
                status: "recognized",
                itemName: "Deboreka Necklace",
            }),
        ]);
    });

    it("delays OCR until the banner text is readable", async () => {
        const analyzer = new RareLootFrameAnalyzer();
        const observedBounds: Array<LootOcrBounds | undefined> = [];
        const readText = vi.fn<LiveLootOcrReader>(async (frames) => {
            observedBounds.push(...frames.map(({ bounds }) => bounds));
            return frames.map(() => ["Twilight of the End - Earring x 1"]);
        });
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: RARE_LOOT_PROFILE,
            dictionary: ["Twilight of the End - Earring"],
            analyzeFrame: (frame) => analyzer.pushFrame(frame),
            ocrSelection: RARE_LOOT_OCR_SELECTION,
            ocrBounds: RARE_LOOT_OCR_BOUNDS,
            eventIdPrefix: "rare",
            readText,
            onResult: (result) => results.push(result),
        });

        for (const ratio of [0, ...Array.from({ length: 4 }, () => 0.7), ...Array.from({ length: 18 }, () => 0)]) {
            coordinator.pushFrame(rareFrame(ratio));
        }
        await coordinator.finish();

        expect(readText).toHaveBeenCalledOnce();
        expect(observedBounds).toEqual(Array.from({ length: 3 }, () => RARE_LOOT_OCR_BOUNDS));
        expect(results).toEqual([
            expect.objectContaining({
                eventId: "rare-0001",
                selectedFrames: [16, 17, 18],
                itemName: "Twilight of the End - Earring",
                quantity: 1,
                status: "recognized",
            }),
        ]);
    });
});
