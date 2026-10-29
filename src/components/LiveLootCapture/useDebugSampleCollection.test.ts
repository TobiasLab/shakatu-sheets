import { describe, expect, it } from "vitest";
import { sampleCollectionChange } from "./useDebugSampleCollection";

describe("sampleCollectionChange", () => {
    it("starts once when recording becomes wanted", () => {
        expect(sampleCollectionChange(true, undefined, false)).toBe("start");
        expect(sampleCollectionChange(true, "idle", false)).toBe("start");
        expect(sampleCollectionChange(true, "finished", false)).toBe("start");
        expect(sampleCollectionChange(true, "running", false)).toBeNull();
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
