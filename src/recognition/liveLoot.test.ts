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

    it("parses OCR spacing and common single-one glyph substitutions", () => {
        expect(parseLootItem("Black Stone x2", ["Black Stone"])).toBe("Black Stone");
        expect(parseLootQuantity("Black Stone x I")).toBe(1);
        expect(parseLootQuantity("Black Stone x0")).toBeNull();
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
        const finishing = coordinator.finish();
        first.resolve(acceptedReadings);
        await secondReadStarted.promise;
        expect(reads).toHaveLength(2);
        expect(results.map(({ eventId }) => eventId)).toEqual(["detected-0001"]);

        second.resolve(acceptedReadings);
        await finishing;
        expect(results.map(({ eventId }) => eventId)).toEqual(["detected-0001", "detected-0002"]);
        expect(results.map(({ status }) => status)).toEqual(["recognized", "recognized"]);
    });

    it("drops over-capacity events without invoking OCR for them", async () => {
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
                reason: "mixed-overflow-summary",
                count: 2,
                backpressureCount: 1,
                resultOverflowCount: 1,
                firstEventId: "detected-0002",
                lastEventId: "detected-0003",
                lastFrame: 9,
            },
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
        expect(failed[0]).toMatchObject({ status: "failed", reason: "ocr-failure" });

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
        expect(withheld[0]).toMatchObject({ status: "withheld", reason: "consensus-withheld" });
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
