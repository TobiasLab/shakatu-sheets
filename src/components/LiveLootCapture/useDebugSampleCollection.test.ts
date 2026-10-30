import { describe, expect, it } from "vitest";
import type { DebugRoiSampleCollectionStatus } from "../../api/tauri";
import { describeSampleCollection, sampleCollectionChange } from "./useDebugSampleCollection";

function run(overrides: Partial<DebugRoiSampleCollectionStatus>): DebugRoiSampleCollectionStatus {
    return {
        phase: "running",
        path: "/samples/run-1",
        acceptedBatchCount: 0,
        droppedBatchCount: 0,
        writtenBatchCount: 0,
        bytesWritten: 2_400_000_000,
        error: null,
        finishReason: null,
        startedAtUnixMs: 0,
        ...overrides,
    };
}

describe("describeSampleCollection", () => {
    const base = { busy: false, ready: true, timerRunning: true, changeFailed: false, now: 2_530_000 };

    it("shows elapsed time, size, and dropped pairs while recording", () => {
        expect(describeSampleCollection({ ...base, collection: run({ droppedBatchCount: 3 }) })).toEqual({
            tone: "recording",
            label: "Recording ROI samples",
            detail: "00:42:10 · 2.40 GB · 3 dropped",
        });
    });

    it("explains what recording is waiting for", () => {
        expect(describeSampleCollection({ ...base, collection: null, ready: false }).detail).toBe(
            "Confirm both loot areas to start.",
        );
        expect(describeSampleCollection({ ...base, collection: null, timerRunning: false }).label).toBe(
            "ROI samples paused",
        );
        expect(
            describeSampleCollection({
                ...base,
                timerRunning: false,
                collection: run({ phase: "finished", finishReason: "explicitlyStopped" }),
            }).detail,
        ).toBe("Starts with the session timer. Last run: 2.40 GB.");
    });

    it("reports runs that ended on their own in plain words", () => {
        expect(
            describeSampleCollection({
                ...base,
                collection: run({ phase: "finished", finishReason: "selectionChanged" }),
            }),
        ).toEqual({
            tone: "problem",
            label: "ROI samples stopped",
            detail: "The loot areas changed. Pause and resume the timer to record again.",
        });
        expect(describeSampleCollection({ ...base, collection: run({ phase: "failed", error: "Disk full" }) })).toEqual(
            { tone: "problem", label: "ROI samples failed", detail: "Disk full" },
        );
    });

    it("reports a start that failed instead of waiting on it", () => {
        expect(describeSampleCollection({ ...base, collection: null, changeFailed: true })).toEqual({
            tone: "problem",
            label: "ROI samples could not start",
            detail: "Pause and resume the timer to try again.",
        });
    });
});

describe("sampleCollectionChange", () => {
    it("starts once when recording becomes wanted", () => {
        expect(sampleCollectionChange(true, undefined, false)).toBe("start");
        expect(sampleCollectionChange(true, "idle", false)).toBe("start");
        expect(sampleCollectionChange(true, "finished", false)).toBe("start");
        expect(sampleCollectionChange(true, "running", true)).toBeNull();
    });

    it("stops a run left over from an earlier stretch so the next one starts fresh", () => {
        expect(sampleCollectionChange(true, "running", false)).toBe("stop");
    });

    it("waits for a finishing run before starting the next one", () => {
        expect(sampleCollectionChange(true, "finalizing", false)).toBeNull();
    });

    it("does not restart a run that ended or failed while still wanted", () => {
        expect(sampleCollectionChange(true, "finished", true)).toBeNull();
        expect(sampleCollectionChange(true, "failed", true)).toBeNull();
        expect(sampleCollectionChange(true, "idle", true)).toBeNull();
    });

    it("stops only a running collection once it is no longer wanted", () => {
        expect(sampleCollectionChange(false, "running", true)).toBe("stop");
        expect(sampleCollectionChange(false, "finalizing", true)).toBeNull();
        expect(sampleCollectionChange(false, "finished", false)).toBeNull();
        expect(sampleCollectionChange(false, undefined, false)).toBeNull();
    });
});
