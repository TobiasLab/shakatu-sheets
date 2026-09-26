import { describe, expect, it } from "vitest";
import {
    analyzeLootRoiFrame,
    LiveLootCoordinator,
    type LiveLootOcrFrame,
    type LiveLootRecognitionResult,
    type LootDetectedRows,
    type LootDetectionProfile,
    type LootRoiFrame,
    LootRowTracker,
    lootFingerprintDistance,
    parseLootItem,
    parseLootQuantity,
    recognizeLootReplay,
    rowBirthCount,
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

const streamingProfile: LootDetectionProfile = {
    width: 100,
    height: 100,
    maxRows: 2,
    bottomCenter: 70,
    spacing: 30,
    rowThreshold: 5,
};

function packedFrame(rowCount: number): LootRoiFrame {
    const pixels = new Uint8ClampedArray(streamingProfile.width * streamingProfile.height * 4);
    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const centerY = streamingProfile.bottomCenter - rowIndex * streamingProfile.spacing;
        for (let x = 28; x < 94; x += 4) {
            const offset = (centerY * streamingProfile.width + x) * 4;
            pixels.fill(255, offset, offset + 4);
        }
    }
    return { width: streamingProfile.width, height: streamingProfile.height, pixels };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const acceptedReadings = [["Black Stone x 2"], ["Black Stone x2"], ["Black Stone x 2"]] as const;

function pushRowSequence(coordinator: LiveLootCoordinator, counts: number[]) {
    const frames = counts.map(packedFrame);
    for (const frame of frames) coordinator.pushFrame(frame);
    return frames;
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
    it("withholds a birth until its lookahead frame arrives", () => {
        const tracker = new LootRowTracker(100, distance);

        tracker.push(row([1]));
        expect(tracker.tracks).toMatchObject([{ firstFrame: 0, baseline: true }]);

        tracker.push(row([1, 2]));
        expect(tracker.tracks.filter(({ baseline }) => !baseline)).toEqual([]);

        tracker.push(row([1, 2]));
        expect(tracker.tracks.filter(({ baseline }) => !baseline).map(({ firstFrame }) => firstFrame)).toEqual([1]);
    });

    it("finishes the terminal frame without inventing an unconfirmed birth", () => {
        const tracker = new LootRowTracker(100, distance);
        tracker.push(row([]));
        tracker.push(row([1]));

        const tracks = tracker.finish();

        expect(tracks.filter(({ baseline }) => !baseline)).toEqual([]);
        expect(tracks).toMatchObject([{ firstFrame: 1, baseline: true, observations: [{ frame: 1 }] }]);
    });

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

    it("retains complete observation history in the batch API", () => {
        const tracks = trackLootRows([row([]), row([1]), row([1]), row([1]), row([1]), row([1])], 100, distance);

        expect(tracks.filter(({ baseline }) => !baseline)[0].observations.map(({ frame }) => frame)).toEqual([
            1, 2, 3, 4, 5,
        ]);
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

    it.each(["Branch of Abundance x 4", "Ancient Spirit Dust x 1"])(
        "withholds a temporal majority contradicted consistently by one frame: %s",
        async (conflict) => {
            const results = await recognizeLootReplay({
                rows: [row([]), row([1]), row([1]), row([1]), row([1])],
                rowThreshold: 100,
                distance,
                dictionary: ["Branch of Abundance", "Ancient Spirit Dust"],
                readText: async () => [
                    [conflict, conflict, "noise"],
                    ["Branch of Abundance x 6", "Branch of Abundance x &", "noise"],
                    ["Branch of Abundance x 6", "Branch of Abundance x 6", "Branch of Abundance x 6"],
                ],
            });
            expect(results[0]).toMatchObject({ itemName: null, quantity: null });
        },
    );

    it("retains temporal support when a third frame is unreadable or has one conflicting pass", async () => {
        for (const thirdFrame of [
            ["noise", "noise", "noise"],
            ["Branch of Abundance x 5", "noise", "noise"],
        ]) {
            const results = await recognizeLootReplay({
                rows: [row([]), row([1]), row([1]), row([1]), row([1])],
                rowThreshold: 100,
                distance,
                dictionary: ["Branch of Abundance"],
                readText: async () => [
                    ["Branch of Abundance x 6", "Branch of Abundance x &", "Branch of Abundance x 6"],
                    thirdFrame,
                    ["Branch of Abundance x 6", "Branch of Abundance x B", "Branch of Abundance x"],
                ],
            });
            expect(results[0]).toMatchObject({ itemName: "Branch of Abundance", quantity: 6 });
        }
    });

    it("recognizes joined quantity markers only with a close, unambiguous item match", () => {
        const dictionary = ["Twilight of the End - Earring", "Black Stone", "Ancient Phoenix"];
        expect(parseLootItem("Twilight of the End = Earringsx 1", dictionary)).toBe("Twilight of the End - Earring");
        expect(parseLootItem("Twilight of the End = Earringx 1", dictionary)).toBe("Twilight of the End - Earring");
        expect(parseLootItem("Black Stonex2", dictionary)).toBe("Black Stone");
        expect(parseLootItem("Black Stone Box 1", dictionary)).toBeNull();
        expect(parseLootItem("Ancient Phoenix 1", dictionary)).toBeNull();
        expect(parseLootItem("Ancient Phoenixx 1", dictionary)).toBe("Ancient Phoenix");
        expect(parseLootItem("Twilight of the End - Earring 1", dictionary)).toBeNull();
        expect(parseLootItem("Black Stonex 1.5", dictionary)).toBeNull();
        expect(parseLootItem("Black Stonex 1 extra", dictionary)).toBeNull();
        expect(parseLootItem("Black Stonex 1", ["Black Stona", "Black Stoni"])).toBeNull();
    });

    it("recovers the observed rare-banner readings through temporal consensus", async () => {
        const results = await recognizeLootReplay({
            rows: [row([]), row([1]), row([1]), row([1]), row([1])],
            rowThreshold: 100,
            distance,
            dictionary: ["Twilight of the End - Earring"],
            readText: async () => [
                [
                    "*Imiilight. of the End — Earrings 1",
                    "_ Twilight of the End = Earringsx 1",
                    "Twilight of the End = Earring. 1",
                ],
                [
                    "Twilight of the End — Earring 1",
                    "Twilight of the End = Earringsx 1",
                    "Twilight of the End = Earring. x 1",
                ],
                [
                    "Twilight of the End = Earringx 1",
                    "Twilight of the End = Earring:x 1",
                    "Twilight of the End = Earringx 1",
                ],
            ],
        });
        expect(results[0]).toMatchObject({ itemName: "Twilight of the End - Earring", quantity: 1 });
    });

    it("recovers a terminal quote without choosing between conflicting quantities", async () => {
        const replay = (readings: string[][]) =>
            recognizeLootReplay({
                rows: [row([]), row([1]), row([1]), row([1]), row([1])],
                rowThreshold: 100,
                distance,
                dictionary: ["Branch of Abundance"],
                readText: async () => readings,
            });
        const recovered = await replay([
            ["‘Branch of Abundance x10 :", "Branch of Abundance x 10", "Branch of Abundance x 110"],
            ["Branch of A bundance x10 Lo", "Branch of Abundance x 10", "Branch of Abundance x 10"],
            ["Branch ol} bundahee £10. 1", "Branch of Abundance x 10 ”", "Branch of Abundance x 110"],
        ]);
        expect(recovered[0]).toMatchObject({ itemName: "Branch of Abundance", quantity: 10 });
        const ambiguous = await replay(
            Array.from({ length: 3 }, () => [
                "Branch of Abundance x 10- - i",
                "Branch of Abundance x 100",
                "Branch of Abundance x 10",
            ]),
        );
        expect(ambiguous[0]).toMatchObject({ itemName: null, quantity: null });
    });

    it("withholds a false x110 when cropped x10 readings include terminal dashes", async () => {
        const results = await recognizeLootReplay({
            rows: [row([]), row([1]), row([1]), row([1]), row([1])],
            rowThreshold: 100,
            distance,
            dictionary: ["Branch of Abundance"],
            readText: async () => [
                ["Branch, of Abundance x 10", "Branch of Abundance x 10", "Branch of Abundance x 110"],
                ["Branch of Abundance x 10", "Branch of Abundance x10", "Branch of Abundance x 110"],
                [": Branch of Abundance x10 -", "Branch of Abundance x10 -", "Branch of Abundance x 110"],
            ],
        });
        expect(results[0]).toMatchObject({ itemName: null, quantity: null });
    });

    it("parses OCR spacing and common single-one glyph substitutions", () => {
        expect(parseLootItem("Black Stone x2", ["Black Stone"])).toBe("Black Stone");
        expect(parseLootQuantity("Black Stone x I")).toBe(1);
        expect(parseLootQuantity("Black Stone x0")).toBeNull();
        expect(parseLootQuantity("Black Stone x999999999999999999999999999999999")).toBeNull();
    });
});

describe("live loot streaming coordination", () => {
    it("transfers frame ownership and waits for lookahead before selecting the exact three frames", async () => {
        const results: LiveLootRecognitionResult[] = [];
        const calls: Array<readonly LiveLootOcrFrame[]> = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async (frames) => {
                calls.push(frames);
                return acceptedReadings;
            },
            onResult: (result) => {
                results.push(result);
            },
        });
        const frames = pushRowSequence(coordinator, [0, 1, 1, 1, 1]);

        expect(calls).toHaveLength(0);
        frames.push(packedFrame(1));
        coordinator.pushFrame(frames[5]);

        expect(calls).toHaveLength(1);
        expect(calls[0].map(({ frame }) => frame)).toEqual([2, 3, 4]);
        expect(calls[0].map(({ roi }) => roi)).toEqual([frames[2], frames[3], frames[4]]);
        expect(calls[0][0].roi).toBe(frames[2]);
        expect(calls[0][1].roi).toBe(frames[3]);
        expect(calls[0][2].roi).toBe(frames[4]);
        expect(calls[0][0].roi.pixels).toBe(frames[2].pixels);

        coordinator.pushFrame(packedFrame(1));
        await coordinator.finish();
        expect(calls).toHaveLength(1);
        expect(results).toEqual([
            {
                eventId: "detected-0001",
                firstFrame: 1,
                selectedFrames: [2, 3, 4],
                itemName: "Black Stone",
                quantity: 2,
                status: "recognized",
                reason: null,
            },
        ]);
    });

    it("requires a strict majority when more than three OCR frames are selected", async () => {
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            retainedFrameCount: 5,
            ocrSelection: { frameCount: 4 },
            readText: async () => [
                ["Black Stone x 2"],
                ["Black Stone x 2"],
                ["Ancient Spirit Dust x 1"],
                ["Branch of Abundance x 1"],
            ],
            onResult: (result) => results.push(result),
        });

        pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1, 1]);
        await coordinator.finish();

        expect(results).toEqual([expect.objectContaining({ status: "withheld", reason: "consensus-withheld" })]);
    });

    it("runs OCR sequentially and preserves recognized event order", async () => {
        const first = deferred<readonly (readonly string[])[]>();
        const second = deferred<readonly (readonly string[])[]>();
        const secondReadStarted = deferred<void>();
        const reads: Array<readonly LiveLootOcrFrame[]> = [];
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 2,
            readText: (frames) => {
                reads.push(frames);
                if (reads.length === 2) secondReadStarted.resolve();
                return reads.length === 1 ? first.promise : second.promise;
            },
            onResult: (result) => {
                results.push(result);
            },
        });
        pushRowSequence(coordinator, [0, 2, 2, 2, 2, 2]);

        expect(reads).toHaveLength(1);
        expect(coordinator.pendingOcrJobCount).toBe(2);
        const finishing = coordinator.finish();
        first.resolve(acceptedReadings);
        await secondReadStarted.promise;
        expect(reads).toHaveLength(2);
        expect(coordinator.pendingOcrJobCount).toBe(1);
        expect(results.map(({ eventId }) => eventId)).toEqual(["detected-0001"]);

        second.resolve(acceptedReadings);
        await finishing;
        expect(coordinator.pendingOcrJobCount).toBe(0);
        expect(results.map(({ eventId }) => eventId)).toEqual(["detected-0001", "detected-0002"]);
        expect(results.map(({ status }) => status)).toEqual(["recognized", "recognized"]);
    });

    it("retains a simultaneous five-row burst when the pending OCR capacity is eight", async () => {
        const pending = deferred<readonly (readonly string[])[]>();
        const results: LiveLootRecognitionResult[] = [];
        const burstProfile: LootDetectionProfile = {
            width: 100,
            height: 240,
            maxRows: 5,
            bottomCenter: 200,
            spacing: 40,
            rowThreshold: 5,
        };
        const burstFrame = (count: number): LootRoiFrame => {
            const pixels = new Uint8ClampedArray(burstProfile.width * burstProfile.height * 4);
            pixels[0] = count;
            return { width: burstProfile.width, height: burstProfile.height, pixels };
        };
        const coordinator = new LiveLootCoordinator({
            profile: burstProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 8,
            readText: () => pending.promise,
            onResult: (result) => results.push(result),
            analyzeFrame: (frame) => {
                const count = frame.pixels[0];
                const observations = Array.from({ length: count }, (_, slot) => {
                    const projection = new Uint8Array(5);
                    projection[slot] = 1;
                    return {
                        slot,
                        centerY: burstProfile.bottomCenter - (burstProfile.maxRows - slot - 1) * burstProfile.spacing,
                        score: 10,
                        fingerprint: { full: projection, quantity: projection },
                    };
                });
                const fingerprints = observations.map(({ fingerprint }) => fingerprint);
                return {
                    count,
                    strength: count * 10,
                    fingerprint: fingerprints[fingerprints.length - 1],
                    fingerprints,
                    observations,
                };
            },
        });

        for (const count of [0, 5, 5, 5, 5, 5]) coordinator.pushFrame(burstFrame(count));

        expect(coordinator.pendingOcrJobCount).toBe(5);
        const finishing = coordinator.finish();
        pending.resolve(acceptedReadings);
        await finishing;

        expect(results).toHaveLength(5);
        expect(results.every(({ status }) => status === "recognized")).toBe(true);
    });

    it("drops over-capacity OCR events without withholding later result deliveries", async () => {
        const pending = deferred<readonly (readonly string[])[]>();
        const reads: Array<readonly LiveLootOcrFrame[]> = [];
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 1,
            readText: (frames) => {
                reads.push(frames);
                return pending.promise;
            },
            onResult: (result) => {
                results.push(result);
            },
        });
        pushRowSequence(coordinator, [0, 2, 2, 2, 2, 2]);
        pushRowSequence(coordinator, [0, 0, 0, 1, 1]);

        expect(reads).toHaveLength(1);
        expect(results).toEqual([]);

        const finishing = coordinator.finish();
        pending.resolve(acceptedReadings);
        await finishing;
        expect(reads).toHaveLength(1);
        expect(results).toEqual([
            {
                eventId: "detected-0001",
                firstFrame: 1,
                selectedFrames: [2, 3, 4],
                itemName: "Black Stone",
                quantity: 2,
                status: "recognized",
                reason: null,
            },
            {
                eventId: null,
                firstFrame: 1,
                selectedFrames: [],
                itemName: null,
                quantity: null,
                status: "dropped",
                reason: "backpressure-summary",
                count: 1,
                backpressureCount: 1,
                resultOverflowCount: 0,
                firstEventId: "detected-0002",
                lastEventId: "detected-0002",
                lastFrame: 1,
            },
            {
                eventId: "detected-0003",
                firstFrame: 9,
                selectedFrames: [],
                itemName: null,
                quantity: null,
                status: "withheld",
                reason: "insufficient-observations",
                capture: expect.objectContaining({ pixels: expect.any(Uint8ClampedArray) }),
            },
        ]);
    });

    it("admits new OCR work after capacity reopens behind an overflow summary", async () => {
        const reads = [
            deferred<readonly (readonly string[])[]>(),
            deferred<readonly (readonly string[])[]>(),
            deferred<readonly (readonly string[])[]>(),
        ];
        const secondReadStarted = deferred<void>();
        const thirdReadStarted = deferred<void>();
        const results: LiveLootRecognitionResult[] = [];
        let readCount = 0;
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 2,
            readText: () => {
                const index = readCount;
                readCount += 1;
                if (readCount === 2) secondReadStarted.resolve();
                if (readCount === 3) thirdReadStarted.resolve();
                return reads[index].promise;
            },
            onResult: (result) => results.push(result),
        });

        pushRowSequence(coordinator, [0, 2, 2, 2, 2, 2]);
        pushRowSequence(coordinator, [0, 0, 0, 1, 1, 1, 1, 1]);
        expect(coordinator.pendingOcrJobCount).toBe(2);
        expect(coordinator.queuedSummaryCount).toBe(1);

        reads[0].resolve(acceptedReadings);
        await secondReadStarted.promise;
        expect(coordinator.pendingOcrJobCount).toBe(1);
        pushRowSequence(coordinator, [0, 0, 0, 1, 1, 1, 1, 1]);
        expect(coordinator.pendingOcrJobCount).toBe(2);
        expect(coordinator.queuedSummaryCount).toBe(1);

        const finishing = coordinator.finish();
        reads[1].resolve(acceptedReadings);
        await thirdReadStarted.promise;
        reads[2].resolve(acceptedReadings);
        await finishing;

        expect(results.map(({ status }) => status)).toEqual(["recognized", "recognized", "dropped", "recognized"]);
        expect(results.map(({ eventId }) => eventId)).toEqual([
            "detected-0001",
            "detected-0002",
            null,
            "detected-0004",
        ]);
    });

    it("reports OCR rejection and consensus withholding explicitly", async () => {
        const failed: LiveLootRecognitionResult[] = [];
        const failingCoordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => {
                throw new Error("OCR unavailable");
            },
            onResult: (result) => {
                failed.push(result);
            },
        });
        pushRowSequence(failingCoordinator, [0, 1, 1, 1, 1, 1]);
        await failingCoordinator.finish();
        expect(failed[0]).toMatchObject({
            status: "failed",
            reason: "ocr-failure",
            capture: { pixels: expect.any(Uint8ClampedArray) },
        });

        const withheld: LiveLootRecognitionResult[] = [];
        const withholdingCoordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone", "Ancient Spirit Dust"],
            readText: async () => [["Black Stone x 1"], ["Black Stone x 2"], ["Ancient Spirit Dust x 1"]],
            onResult: (result) => {
                withheld.push(result);
            },
        });
        pushRowSequence(withholdingCoordinator, [0, 1, 1, 1, 1, 1]);
        await withholdingCoordinator.finish();
        expect(withheld[0]).toMatchObject({
            status: "withheld",
            reason: "consensus-withheld",
            capture: { pixels: expect.any(Uint8ClampedArray) },
        });
    });

    it("distinguishes item-profile and quantity OCR withholding", async () => {
        for (const [readings, reason] of [
            [["Branch of Abundance x 4"], "item-not-recognized"],
            [["Black Stone"], "quantity-not-recognized"],
        ] as const) {
            const results: LiveLootRecognitionResult[] = [];
            const coordinator = new LiveLootCoordinator({
                profile: streamingProfile,
                dictionary: ["Black Stone"],
                readText: async () => [readings, readings, readings],
                onResult: (result) => results.push(result),
            });
            pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1]);
            await coordinator.finish();
            expect(results[0]).toMatchObject({ status: "withheld", reason });
        }
    });

    it("aborts active OCR, clears queued jobs, and promptly settles finish on an idempotent stop", async () => {
        const pending = deferred<readonly (readonly string[])[]>();
        const results: LiveLootRecognitionResult[] = [];
        let readCount = 0;
        let signal: AbortSignal | undefined;
        let activeFrames: readonly LiveLootOcrFrame[] | undefined;
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 2,
            readText: (frames, readerSignal) => {
                readCount += 1;
                signal = readerSignal;
                activeFrames = frames;
                return pending.promise;
            },
            onResult: (result) => {
                results.push(result);
            },
        });
        pushRowSequence(coordinator, [0, 2, 2, 2, 2, 2]);
        expect(signal?.aborted).toBe(false);

        const firstFinish = coordinator.finish();
        coordinator.stop();
        coordinator.stop();
        await firstFinish;
        expect(signal?.aborted).toBe(true);
        expect(activeFrames).toHaveLength(0);
        expect(readCount).toBe(1);
        expect(coordinator.retainedFrameCount).toBe(0);
        expect(coordinator.retainedTrackCount).toBe(0);
        expect(coordinator.pendingCandidateCount).toBe(0);
        expect(coordinator.pendingOcrJobCount).toBe(0);
        expect(() => coordinator.pushFrame(packedFrame(1))).toThrow("stopped or finished");
        expect(coordinator.finish()).toBe(firstFinish);

        pending.resolve(acceptedReadings);
        await Promise.resolve();
        await Promise.resolve();
        expect(results).toEqual([]);
    });

    it("does not turn a throwing recognized-result callback into an OCR failure", async () => {
        const statuses: string[] = [];
        const callbackError = new Error("recognized callback failed");
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => acceptedReadings,
            onResult: (result) => {
                statuses.push(result.status);
                throw callbackError;
            },
        });
        pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1]);

        await expect(coordinator.finish()).rejects.toBe(callbackError);
        expect(statuses).toEqual(["recognized"]);
    });

    it("reports a callback error when the callback stops capture reentrantly", async () => {
        const pending = deferred<readonly (readonly string[])[]>();
        const callbackError = new Error("stopping callback failed");
        let coordinator: LiveLootCoordinator;
        coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: () => pending.promise,
            onResult: () => {
                coordinator.stop();
                throw callbackError;
            },
        });
        pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1]);
        const finishing = coordinator.finish();

        pending.resolve(acceptedReadings);

        await expect(finishing).rejects.toBe(callbackError);
    });

    it("continues draining when a failure-result callback throws", async () => {
        const statuses: string[] = [];
        const callbackError = new Error("failure callback failed");
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => {
                throw new Error("OCR failed");
            },
            onResult: (result) => {
                statuses.push(result.status);
                throw callbackError;
            },
        });
        pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1]);

        await expect(coordinator.finish()).rejects.toBe(callbackError);
        expect(statuses).toEqual(["failed"]);
    });

    it("rejects a thenable-returning callback without awaiting it or blocking later results", async () => {
        const statuses: string[] = [];
        const callbackCompletion = deferred<void>();
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => acceptedReadings,
            onResult: (result) => {
                statuses.push(result.status);
                if (statuses.length === 1) return callbackCompletion.promise;
            },
        });
        pushRowSequence(coordinator, [0, 2, 2, 2, 2, 2]);

        await expect(coordinator.finish()).rejects.toThrow("Live loot result callbacks must be synchronous.");
        expect(statuses).toEqual(["recognized", "recognized"]);
        callbackCompletion.reject(new Error("late callback rejection"));
        await Promise.resolve();
        await Promise.resolve();
    });

    it("publishes a stable finish promise before a callback can finish reentrantly", async () => {
        let callbackFinish: Promise<void> | undefined;
        let coordinator: LiveLootCoordinator;
        coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => acceptedReadings,
            onResult: () => {
                callbackFinish = coordinator.finish();
            },
        });
        pushRowSequence(coordinator, [0, 1, 1]);

        const finish = coordinator.finish();
        expect(callbackFinish).toBe(finish);
        await finish;
    });

    it("reports a callback that returns finish as misuse without deadlocking", async () => {
        const callbackStarted = deferred<void>();
        const delivered: Array<string | null> = [];
        let callbackFinish: Promise<void> | undefined;
        let coordinator: LiveLootCoordinator;
        coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 2,
            readText: async () => acceptedReadings,
            onResult: (result) => {
                delivered.push(result.eventId);
                if (delivered.length !== 1) return;
                callbackFinish = coordinator.finish();
                callbackStarted.resolve();
                return callbackFinish;
            },
        });
        pushRowSequence(coordinator, [0, 2, 2, 2, 2, 2]);

        await callbackStarted.promise;
        expect(callbackFinish).toBeDefined();
        expect(coordinator.finish()).toBe(callbackFinish);
        await expect(callbackFinish).rejects.toThrow("Live loot result callbacks must be synchronous.");
        expect(delivered).toEqual(["detected-0001", "detected-0002"]);
    });

    it("finalizes an ended insufficient track without waiting for finish", () => {
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => acceptedReadings,
            onResult: (result) => {
                results.push(result);
            },
        });
        pushRowSequence(coordinator, [0, 1, 1, 0, 0, 0]);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            eventId: "detected-0001",
            status: "withheld",
            reason: "insufficient-observations",
        });
    });

    it("settles insufficient terminal observations and makes finish idempotent", async () => {
        const results: LiveLootRecognitionResult[] = [];
        let readCount = 0;
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async () => {
                readCount += 1;
                return acceptedReadings;
            },
            onResult: (result) => {
                results.push(result);
            },
        });
        pushRowSequence(coordinator, [0, 1, 1]);

        const firstFinish = coordinator.finish();
        expect(coordinator.finish()).toBe(firstFinish);
        await firstFinish;
        coordinator.stop();
        coordinator.stop();

        expect(readCount).toBe(0);
        expect(results).toEqual([
            {
                eventId: "detected-0001",
                firstFrame: 1,
                selectedFrames: [],
                itemName: null,
                quantity: null,
                status: "withheld",
                reason: "insufficient-observations",
                capture: expect.objectContaining({ pixels: expect.any(Uint8ClampedArray) }),
            },
        ]);
        expect(() => coordinator.pushFrame(packedFrame(1))).toThrow("stopped or finished");
    });

    it("keeps only the configured bounded rolling frame window", async () => {
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: [],
            retainedFrameCount: 5,
            readText: async () => [],
            onResult: () => undefined,
        });
        for (let index = 0; index < 20; index += 1) {
            coordinator.pushFrame(packedFrame(0));
            expect(coordinator.retainedFrameCount).toBeLessThanOrEqual(5);
        }
        expect(coordinator.retainedFrameCount).toBe(5);

        await coordinator.finish();
        expect(coordinator.retainedFrameCount).toBe(0);

        expect(
            () =>
                new LiveLootCoordinator({
                    profile: streamingProfile,
                    dictionary: [],
                    maxPendingResults: 0,
                    readText: async () => [],
                    onResult: () => undefined,
                }),
        ).toThrow("positive integer");
        expect(
            () =>
                new LiveLootCoordinator({
                    profile: streamingProfile,
                    dictionary: [],
                    ocrSelection: { frameCount: 1 },
                    readText: async () => [],
                    onResult: () => undefined,
                }),
        ).toThrow("at least two");
        expect(
            () =>
                new LiveLootCoordinator({
                    profile: streamingProfile,
                    dictionary: [],
                    retainedFrameCount: 4,
                    ocrSelection: { frameCount: 4 },
                    readText: async () => [],
                    onResult: () => undefined,
                }),
        ).toThrow("birth confirmation");
        expect(
            () =>
                new LiveLootCoordinator({
                    profile: streamingProfile,
                    dictionary: [],
                    ocrBounds: { left: 0, right: streamingProfile.width + 1, top: 0, bottom: 1 },
                    readText: async () => [],
                    onResult: () => undefined,
                }),
        ).toThrow("OCR bounds");
    });

    it("bounds track and observation retention across repeated long-stream events", async () => {
        const firstRead = deferred<readonly (readonly string[])[]>();
        let readCount = 0;
        const results: LiveLootRecognitionResult[] = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 1,
            maxPendingResults: 2,
            readText: () => {
                readCount += 1;
                return firstRead.promise;
            },
            onResult: (result) => {
                results.push(result);
            },
        });
        coordinator.pushFrame(packedFrame(0));
        for (let cycle = 0; cycle < 25; cycle += 1) {
            for (const count of [1, 1, 1, 1, 1, 0, 0, 0]) {
                coordinator.pushFrame(packedFrame(count));
                expect(coordinator.retainedFrameCount).toBeLessThanOrEqual(4);
                expect(coordinator.retainedTrackCount).toBeLessThanOrEqual(streamingProfile.maxRows);
                expect(coordinator.retainedObservationCount).toBeLessThanOrEqual(streamingProfile.maxRows * 3);
                expect(coordinator.pendingCandidateCount).toBeLessThanOrEqual(streamingProfile.maxRows);
                expect(coordinator.queuedDeliveryCount).toBeLessThanOrEqual(1 + 2 + 1);
                expect(coordinator.queuedSummaryCount).toBeLessThanOrEqual(1);
            }
        }
        expect(readCount).toBe(1);

        const finishing = coordinator.finish();
        firstRead.resolve(acceptedReadings);
        await finishing;
        expect(coordinator.retainedTrackCount).toBe(0);
        expect(coordinator.retainedObservationCount).toBe(0);
        expect(coordinator.pendingCandidateCount).toBe(0);
        expect(results.map(({ status }) => status)).toEqual(["recognized", "dropped"]);
        expect(results[1]).toMatchObject({
            reason: "backpressure-summary",
            count: 24,
            backpressureCount: 24,
            resultOverflowCount: 0,
            firstEventId: "detected-0002",
            lastEventId: "detected-0025",
        });
        expect(results[1]).not.toHaveProperty("frames");
        expect(results[1]).not.toHaveProperty("roi");
    });

    it("bounds ordinary outcomes behind OCR and starts a later summary during summary delivery", async () => {
        const firstRead = deferred<readonly (readonly string[])[]>();
        const laterSummaryDelivered = deferred<void>();
        const results: LiveLootRecognitionResult[] = [];
        let readCount = 0;
        let expandedFirstSummary = false;
        let maximumQueued = 0;
        let coordinator: LiveLootCoordinator;

        function pushInsufficientEvents(count: number) {
            for (let cycle = 0; cycle < count; cycle += 1) {
                for (const rowCount of [1, 1, 0, 0, 0]) {
                    coordinator.pushFrame(packedFrame(rowCount));
                    maximumQueued = Math.max(maximumQueued, coordinator.queuedDeliveryCount);
                    expect(coordinator.queuedSummaryCount).toBeLessThanOrEqual(1);
                }
            }
        }

        coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            maxPendingOcrJobs: 1,
            maxPendingResults: 1,
            readText: () => {
                readCount += 1;
                return firstRead.promise;
            },
            onResult: (result) => {
                results.push(result);
                if (result.reason === "result-overflow-summary" && !expandedFirstSummary) {
                    expandedFirstSummary = true;
                    pushInsufficientEvents(3);
                } else if (result.reason === "result-overflow-summary") {
                    laterSummaryDelivered.resolve();
                }
            },
        });
        coordinator.pushFrame(packedFrame(0));
        for (const rowCount of [1, 1, 1, 1, 1, 0, 0, 0]) coordinator.pushFrame(packedFrame(rowCount));
        pushInsufficientEvents(3);
        expect(results).toEqual([]);
        expect(readCount).toBe(1);
        expect(maximumQueued).toBeLessThanOrEqual(1 + 1 + 1);

        firstRead.resolve(acceptedReadings);
        await laterSummaryDelivered.promise;
        await coordinator.finish();
        expect(results).toHaveLength(4);
        expect(results[0]).toMatchObject({
            eventId: "detected-0001",
            status: "recognized",
        });
        expect(results[1]).toMatchObject({
            eventId: "detected-0002",
            reason: "insufficient-observations",
        });
        expect(results[2]).toMatchObject({
            eventId: null,
            reason: "result-overflow-summary",
            count: 2,
            backpressureCount: 0,
            resultOverflowCount: 2,
            firstEventId: "detected-0003",
            lastEventId: "detected-0004",
        });
        expect(results[2]).not.toHaveProperty("frames");
        expect(results[2]).not.toHaveProperty("roi");
        expect(results[3]).toMatchObject({
            eventId: null,
            reason: "result-overflow-summary",
            count: 3,
            backpressureCount: 0,
            resultOverflowCount: 3,
            firstEventId: "detected-0005",
            lastEventId: "detected-0007",
        });
    });
});

describe("notification evidence regressions", () => {
    it("rejects bright neutral texture spread above and below the text baseline", () => {
        const frame = packedFrame(0);
        for (let y = 60; y <= 80; y += 2) {
            for (let x = 28; x < 94; x += 4) frame.pixels.fill(255, (y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
        }
        expect(analyzeLootRoiFrame(frame, streamingProfile).count).toBe(0);
    });

    it("rejects warm scenery even when its edges fall on the text baseline", () => {
        const frame = packedFrame(1);
        for (let x = 28; x < 94; x += 4) frame.pixels.set([180, 160, 130, 255], (70 * 100 + x) * 4);
        expect(analyzeLootRoiFrame(frame, streamingProfile).count).toBe(0);
    });

    it("ignores scenery beyond text whitespace without ignoring another quantity digit", () => {
        const full = new Uint8Array(80);
        full.fill(3, 0, 25);
        full.set([6, 2, 4], 27);
        const base = { full, quantity: full.slice(20) };
        const scenery = full.slice();
        scenery.fill(10, 45);
        expect(lootFingerprintDistance(base, { full: scenery, quantity: scenery.slice(20) })).toBeCloseTo(0);
        const extraDigit = full.slice();
        extraDigit.set([10, 4, 3, 10, 6], 32);
        expect(lootFingerprintDistance(base, { full: extraDigit, quantity: extraDigit.slice(20) })).toBeGreaterThan(
            0.1,
        );
    });

    it("waits for visually consistent OCR frames within the same event", () => {
        const track = {
            id: "camera-motion",
            firstFrame: 0,
            baseline: false,
            observations: [0, 0.05, 0.3, 0.31, 0.32].map((fingerprint, frame) => ({
                frame,
                slot: 4,
                centerY: 204,
                score: 300,
                fingerprint,
            })),
        };
        expect(
            selectLootOcrObservations(track, 100, undefined, distance).map((observation) => observation.frame),
        ).toEqual([2, 3, 4]);
    });

    it("requires a changed row to remain different from its predecessor", () => {
        expect(rowBirthCount(row([0]), row([0.15]), row([0.02]), 100, distance)).toBe(0);
        expect(rowBirthCount(row([0]), row([0.15]), row([0.16]), 100, distance)).toBe(1);
    });

    it("retains a readable new drop when older rows expire in the same frame", () => {
        const previous = row([1, 2, 3]);
        const current = row([3, 4], [200, 110]);
        expect(rowBirthCount(previous, current, current, 100, distance)).toBe(1);
    });

    it("allows a strongly different shorter item while the existing stack loses brightness", () => {
        const previous = row([1, 2, 3], [600, 600, 600]);
        const current = row([2.2, 3, 4], [300, 300, 250]);
        const next = row([3, 4, 3], [300, 250, 300]);
        expect(rowBirthCount(previous, current, next, 100, distance)).toBe(1);
    });

    it("confirms a short replacement below twice the row threshold", () => {
        const previous = row([0], [717]);
        const current = row([0.44], [346]);
        expect(rowBirthCount(previous, current, current, 196, distance)).toBe(1);
        expect(rowBirthCount(previous, current, previous, 196, distance)).toBe(0);
        const weakChange = row([0.15], [346]);
        expect(rowBirthCount(previous, weakChange, weakChange, 196, distance)).toBe(0);
    });

    it("keeps identities through a confirmed stack shift while the top row fades", () => {
        const previous = row([1, 2, 3, 4], [972, 673, 519, 705]);
        const current = row([2, 3, 4, 5], [649, 502, 609, 632]);
        expect(rowBirthCount(previous, current, current, 196, distance)).toBe(1);
        const stationaryFade = row([1, 2, 3, 4], [649, 502, 609, 632]);
        expect(rowBirthCount(previous, stationaryFade, stationaryFade, 196, distance)).toBe(0);
        const tracks = trackLootRows([previous, current, current], 196, distance);
        expect(tracks.filter((track) => !track.baseline)).toHaveLength(1);
        expect(tracks[2].observations.map(({ slot }) => slot)).toEqual([3, 2, 2]);
    });

    it("does not count a confirmed shift again when the stationary stack brightens", () => {
        const previous = row([0, 1, 2], [443, 751, 1077]);
        const shifted = row([1, 2, 1], [711, 759, 594]);
        const brighter = row([1, 2, 1], [1027, 881, 687]);
        const tracks = trackLootRows([previous, shifted, brighter, brighter], 196, distance);
        expect(tracks.filter((track) => !track.baseline).map((track) => track.firstFrame)).toEqual([1]);
        const newItem = row([2, 1, 3], [1027, 881, 687]);
        const distinct = trackLootRows([previous, shifted, newItem, newItem], 196, distance);
        expect(distinct.filter((track) => !track.baseline).map((track) => track.firstFrame)).toEqual([1, 2]);
        const growing = row([0, 1, 2, 1], [443, 751, 1077, 594]);
        const identicalAddition = row([0, 1, 2, 1, 1], [443, 751, 1077, 594, 594]);
        const additions = trackLootRows([previous, growing, identicalAddition, identicalAddition], 196, distance);
        expect(additions.filter((track) => !track.baseline).map((track) => track.firstFrame)).toEqual([1, 2]);
    });

    it.each([
        [56, 65],
        [64, 73],
        [92, 96],
    ])("bounds OCR after glyph %i while retaining the trailing gap and long names", async (lastGlyph, right) => {
        const bounds: Array<LiveLootOcrFrame["bounds"]> = [];
        const coordinator = new LiveLootCoordinator({
            profile: streamingProfile,
            dictionary: ["Black Stone"],
            readText: async (frames) => {
                bounds.push(...frames.map((frame) => frame.bounds));
                return acceptedReadings;
            },
            onResult: () => undefined,
        });
        coordinator.pushFrame(packedFrame(0));
        for (let index = 0; index < 5; index += 1) {
            const frame = packedFrame(0);
            for (let x = 28; x <= lastGlyph; x += 4) {
                frame.pixels.fill(255, (70 * 100 + x) * 4, (70 * 100 + x) * 4 + 4);
            }
            // Scenery beyond the whitespace must not enlarge the text crop.
            frame.pixels.fill(255, (70 * 100 + 76) * 4, (70 * 100 + 76) * 4 + 4);
            coordinator.pushFrame(frame);
        }
        await coordinator.finish();
        expect(bounds).toEqual(Array.from({ length: 3 }, () => ({ left: 25, right, top: 58, bottom: 82 })));
    });

    it.each([
        [undefined, 45],
        ["korean", 45],
        ["strong-sword", 81],
    ] as const)("keeps tinted Strong Sword glyphs inside the OCR crop with font %s", async (font, right) => {
        const bounds: Array<LiveLootOcrFrame["bounds"]> = [];
        const coordinator = new LiveLootCoordinator({
            font,
            profile: streamingProfile,
            dictionary: ["WON Origin Shard"],
            readText: async (frames) => {
                bounds.push(...frames.map((frame) => frame.bounds));
                return frames.map(() => ["WON Origin Shard x 1"]);
            },
            onResult: () => undefined,
        });
        coordinator.pushFrame(packedFrame(0));
        for (let index = 0; index < 5; index++) {
            const frame = packedFrame(0);
            for (let x = 28; x <= 72; x += 4) {
                const color = x >= 40 && x <= 60 ? [230, 210, 185, 255] : [255, 255, 255, 255];
                frame.pixels.set(color, (70 * 100 + x) * 4);
            }
            // Bright scenery after the line's trailing whitespace must still be excluded.
            frame.pixels.set([255, 255, 255, 255], (70 * 100 + 92) * 4);
            const { ocrExtent, ...fingerprint } = analyzeLootRoiFrame(frame, streamingProfile, font).fingerprints[0];
            expect(fingerprint).toEqual(analyzeLootRoiFrame(frame, streamingProfile).fingerprints[0]);
            expect(ocrExtent).toBe(font === "strong-sword" ? 54 : undefined);
            coordinator.pushFrame(frame);
        }
        await coordinator.finish();
        expect(bounds).toEqual(Array.from({ length: 3 }, () => ({ left: 25, right, top: 58, bottom: 82 })));
    });

    it("accepts trailing OCR punctuation but rejects ambiguous quantities and trailing words", () => {
        expect(parseLootQuantity("Embers of Ynix - Armor x1 .")).toBe(1);
        expect(parseLootQuantity("Branch of Abundance x10 -")).toBe(10);
        expect(parseLootItem("Branch of Abundance x10 -", ["Branch of Abundance"])).toBe("Branch of Abundance");
        expect(parseLootQuantity("Branch of Abundance x 10 ”")).toBe(10);
        expect(parseLootItem("Branch of Abundance x 10 ”", ["Branch of Abundance"])).toBe("Branch of Abundance");
        expect(parseLootItem("Embers of Ynix = Armor x1 .", ["Embers of Ynix - Armor"])).toBe("Embers of Ynix - Armor");
        for (const suffix of ["1.5", "1,000", "1 extra", "-1", "1 2", "1 - 2", "1 - extra"]) {
            expect(parseLootQuantity(`Black Stone x ${suffix}`)).toBeNull();
        }
    });
});

it("keeps original evidence and chooses clearer additional observations from a bounded window", () => {
    const observations = [1, 4, 3, 5, 2, 6].map((quality, frame) => ({
        frame,
        slot: 0,
        centerY: 70,
        score: 300,
        quality,
        fingerprint: 1,
    }));
    const track = { id: "test", firstFrame: 0, baseline: false, observations };
    expect(
        selectLootOcrObservations(track, 100, { delayFrames: 0, windowFrames: 6, maximumFrameCount: 5 }, distance).map(
            ({ frame }) => frame,
        ),
    ).toEqual([0, 1, 2, 3, 5]);
});

it("flushes short tracks at finish and keeps the extended selection window bounded", async () => {
    const calls: number[][] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 5 },
        readText: async (frames) => {
            calls.push(frames.map(({ frame }) => frame));
            return acceptedReadings;
        },
        onResult: () => {},
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1]);
    expect(calls).toEqual([]);
    await coordinator.finish();
    expect(calls).toEqual([[2, 3, 4]]);
    expect(coordinator.retainedFrameCount).toBe(0);
});

it("keeps a clean three-frame run when a later observation is occluded", () => {
    const track = {
        id: "test",
        firstFrame: 0,
        baseline: false,
        observations: [1, 1, 1, 2, 2].map((fingerprint, frame) => ({
            frame,
            slot: 0,
            centerY: 70,
            score: 300,
            fingerprint,
        })),
    };
    expect(
        selectLootOcrObservations(track, 100, { delayFrames: 0, windowFrames: 5 }, distance).map(({ frame }) => frame),
    ).toEqual([0, 1, 2]);
});

it.each([false, true])("reads additional frames only for unresolved events (unresolved: %s)", async (unresolved) => {
    const calls: number[][] = [];
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: async (frames) => {
            calls.push(frames.map(({ frame }) => frame));
            return calls.length === 1 && unresolved
                ? [["Black Stone x 2"], ["noise"], ["noise"]]
                : frames.map(() => ["Black Stone x 2"]);
        },
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(coordinator.retainedFrameCount).toBeLessThanOrEqual(7);
    await coordinator.finish();
    expect(calls).toEqual(
        unresolved
            ? [
                  [2, 3, 4],
                  [5, 6],
              ]
            : [[2, 3, 4]],
    );
    expect(results).toEqual([
        expect.objectContaining({
            status: "recognized",
            quantity: 2,
            selectedFrames: unresolved ? [2, 3, 4, 5, 6] : [2, 3, 4],
        }),
    ]);
});

it("preserves conflicting original OCR evidence when later readings agree", async () => {
    let calls = 0;
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: async (frames) =>
            ++calls === 1
                ? [["Black Stone x 2"], ["Black Stone x 3"], ["Black Stone x 3"]]
                : frames.map(() => ["Black Stone x 3"]),
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1, 1, 1, 1]);
    await coordinator.finish();
    expect(calls).toBe(2);
    expect(results).toEqual([
        expect.objectContaining({ status: "withheld", reason: "consensus-withheld", quantity: null }),
    ]);
});

it("does not replace the first usable run with a longer different row", () => {
    const track = {
        id: "test",
        firstFrame: 0,
        baseline: false,
        observations: [1, 1, 1, 2, 2, 2, 2].map((fingerprint, frame) => ({
            frame,
            slot: 0,
            centerY: 70,
            score: 300,
            fingerprint,
        })),
    };
    expect(
        selectLootOcrObservations(track, 100, { delayFrames: 0, windowFrames: 6, maximumFrameCount: 5 }, distance).map(
            ({ frame }) => frame,
        ),
    ).toEqual([0, 1, 2]);
});

it("reads a short event before its original frames leave the rolling buffer", async () => {
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: async (frames) => frames.map(() => ["Black Stone x 2"]),
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    await coordinator.finish();
    expect(results).toEqual([
        expect.objectContaining({ status: "recognized", quantity: 2, selectedFrames: [2, 3, 4] }),
    ]);
});

it("releases supplementary frames and suppresses late results when stopped during the second OCR call", async () => {
    const pending = deferred<readonly (readonly string[])[]>();
    const started = deferred<void>();
    const results: LiveLootRecognitionResult[] = [];
    const calls: Array<readonly LiveLootOcrFrame[]> = [];
    let signal: AbortSignal | undefined;
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: (frames, readerSignal) => {
            calls.push(frames);
            if (calls.length === 1) return Promise.resolve([["Black Stone x 2"], ["noise"], ["noise"]]);
            signal = readerSignal;
            started.resolve();
            return pending.promise;
        },
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1, 1, 1, 1]);
    const finish = coordinator.finish();
    await started.promise;
    expect(calls.map((frames) => frames.length)).toEqual([0, 2]);
    coordinator.stop();
    await finish;
    expect(signal?.aborted).toBe(true);
    expect(calls.map((frames) => frames.length)).toEqual([0, 0]);
    expect(coordinator.retainedFrameCount).toBe(0);
    expect(coordinator.pendingOcrJobCount).toBe(0);
    pending.resolve([["Black Stone x 2"], ["Black Stone x 2"]]);
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([]);
});

it.each([false, true])("preserves OCR timing and read limits at 16 FPS (unresolved: %s)", async (unresolved) => {
    const calls: number[][] = [];
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        sampleFps: 16,
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: async (frames) => {
            calls.push(frames.map(({ frame }) => frame));
            return calls.length === 1 && unresolved
                ? [["Black Stone x 2"], ["noise"], ["noise"]]
                : frames.map(() => ["Black Stone x 2"]);
        },
        onResult: (result) => results.push(result),
    });
    coordinator.pushFrame(packedFrame(0));
    for (let index = 0; index < 12; index++) coordinator.pushFrame(packedFrame(1));
    expect(calls).toEqual([]);
    coordinator.pushFrame(packedFrame(1));
    coordinator.pushFrame(packedFrame(1));
    expect(coordinator.retainedFrameCount).toBe(12);
    await coordinator.finish();
    expect(calls).toEqual(
        unresolved
            ? [
                  [3, 5, 7],
                  [9, 11],
              ]
            : [[3, 5, 7]],
    );
    expect(results).toEqual([expect.objectContaining({ status: "recognized", quantity: 2 })]);
});

it.each([false, true])("uses learned recovery only for unresolved results (accepted OCR: %s)", async (accepted) => {
    let calls = 0;
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: async (frames) => frames.map(() => [accepted ? "Black Stone x 8" : "Black Stone x &"]),
        suggestQuantity: (frames, readings) => {
            calls++;
            expect(frames).toHaveLength(5);
            expect(readings).toHaveLength(5);
            return { quantity: 6, itemName: "Black Stone", automatic: true };
        },
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 1, 1, 1, 1]);
    await coordinator.finish();
    expect(calls).toBe(accepted ? 0 : 1);
    expect(results).toEqual([expect.objectContaining({ status: "recognized", quantity: accepted ? 8 : 6 })]);
    expect(results[0]).not.toHaveProperty("capture");
    if (!accepted) expect(results[0]).toHaveProperty("learnedQuantity", true);
});

it("retains the original capture and readings when learned recovery needs confirmation", async () => {
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        readText: async (frames) => frames.map(() => ["Black Stone x &"]),
        suggestQuantity: () => ({ quantity: 6, itemName: "Black Stone", automatic: false }),
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 0, 0]);
    await coordinator.finish();
    expect(results).toEqual([
        expect.objectContaining({
            status: "withheld",
            quantity: null,
            capture: expect.objectContaining({ originalText: "Black Stone x &" }),
            quantitySuggestion: { quantity: 6, itemName: "Black Stone", automatic: false },
        }),
    ]);
});

it("keeps the crop and every selected frame's readings and raw passes together across supplementary OCR", async () => {
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        ocrSelection: { windowFrames: 6, maximumFrameCount: 5 },
        readText: async (frames) =>
            frames.map((frame) => {
                frame.diagnostics?.passes.push({
                    threshold: 150,
                    scale: 2,
                    region: "line",
                    text: `frame ${frame.frame}: Black Stone x &`,
                });
                return [`Black Stone x ? (${frame.frame})`];
            }),
        onResult: (result) => results.push(result),
    });
    const frames = [0, 1, 1, 1, 1, 1, 1, 1, 1].map(packedFrame);
    frames.forEach((frame, index) => {
        coordinator.pushFrame({ ...frame, captureBatch: { captureToken: 123, batchId: 100 + index } });
    });
    await coordinator.finish();
    const result = results[0];
    if (result.status === "dropped") throw Error("Expected an event");
    expect(result.capture?.ocrFrames).toHaveLength(5);
    expect(result.capture?.sourceFrame).toEqual(result.capture?.ocrFrames?.[0]);
    expect(result.capture?.sourceFrame).toMatchObject({
        frame: 2,
        captureToken: 123,
        batchId: 102,
        readings: ["Black Stone x ? (2)"],
        passes: [{ threshold: 150, scale: 2, region: "line", text: "frame 2: Black Stone x &" }],
    });
    expect(result.capture?.ocrFrames?.map((frame) => frame.frame)).toEqual(result.selectedFrames);
    expect(result.capture?.ocrFrames?.[4].readings).toEqual([`Black Stone x ? (${result.selectedFrames[4]})`]);
    expect(coordinator.retainedFrameCount).toBe(0);
});

it("preserves completed raw passes on OCR failure without inventing consensus readings", async () => {
    const results: LiveLootRecognitionResult[] = [];
    const coordinator = new LiveLootCoordinator({
        profile: streamingProfile,
        dictionary: ["Black Stone"],
        readText: async (frames) => {
            frames[0].diagnostics?.passes.push({ threshold: 130, scale: 2, region: "line", text: "Black Stone x 9" });
            throw Error("OCR stopped midway");
        },
        onResult: (result) => results.push(result),
    });
    pushRowSequence(coordinator, [0, 1, 1, 1, 1, 0, 0]);
    await coordinator.finish();
    expect(results[0]).toMatchObject({
        status: "failed",
        capture: { sourceFrame: { readings: [], passes: [{ text: "Black Stone x 9" }] } },
    });
});

it("checks intervening 16 FPS observations before selecting spaced OCR evidence", () => {
    const track = {
        id: "test",
        firstFrame: 0,
        baseline: false,
        observations: [1, 2, 1, 2, 1].map((fingerprint, frame) => ({
            frame,
            slot: 0,
            centerY: 70,
            score: 300,
            fingerprint,
        })),
    };
    expect(selectLootOcrObservations(track, 100, { delayFrames: 0, frameStep: 2 }, distance)).toEqual([]);
});

it.each([2, 3, 4])("retains an identical row through short 16 FPS gaps (%i empty samples)", (emptyCount) => {
    const tracker = new LootRowTracker(100, distance, { emptyFrameLimit: 4 });
    for (const rows of [row([1]), ...Array.from({ length: emptyCount }, () => row([])), row([1]), row([1])]) {
        tracker.push(rows);
    }
    expect(tracker.finish().filter(({ baseline }) => !baseline)).toHaveLength(emptyCount < 4 ? 0 : 1);
});

it("rejects gradual changes between the spaced OCR frames at 16 FPS", () => {
    const track = {
        id: "drifting",
        firstFrame: 0,
        baseline: false,
        observations: [1, 1.06, 1.12, 1.18, 1.24].map((fingerprint, frame) => ({
            frame,
            slot: 0,
            centerY: 70,
            score: 300,
            fingerprint,
        })),
    };
    expect(selectLootOcrObservations(track, 100, { delayFrames: 0, frameStep: 2 }, distance)).toEqual([]);
});
