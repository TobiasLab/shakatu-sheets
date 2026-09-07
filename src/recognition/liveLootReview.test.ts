import { describe, expect, it, vi } from "vitest";
import type { LiveLootRecognitionResult } from "./liveLoot";
import {
    acceptLiveLootReviewEntry,
    appendLiveLootReviewResult,
    correctLiveLootReviewEntry,
    type LiveLootReviewEntry,
} from "./liveLootReview";

function entry(id: number, status: LiveLootRecognitionResult["status"] = "recognized"): LiveLootReviewEntry {
    const result: LiveLootRecognitionResult =
        status === "recognized"
            ? {
                  eventId: `detected-${id}`,
                  firstFrame: id,
                  selectedFrames: [id, id + 1, id + 2],
                  itemName: "Black Stone",
                  quantity: 1,
                  status,
                  reason: null,
              }
            : {
                  eventId: `detected-${id}`,
                  firstFrame: id,
                  selectedFrames: [],
                  itemName: null,
                  quantity: null,
                  status: "failed",
                  reason: "ocr-failure",
              };
    return { id, source: "normal", result, accepted: false, error: "" };
}

describe("appendLiveLootReviewResult", () => {
    it("prepends results within the configured bound", () => {
        expect(appendLiveLootReviewResult([entry(1)], entry(2), 2)).toEqual({
            results: [entry(2), entry(1)],
            omittedCount: 0,
        });
    });

    it("evicts accepted history before unresolved results", () => {
        const accepted = { ...entry(1), accepted: true };
        const pending = entry(2);
        expect(appendLiveLootReviewResult([pending, accepted], entry(3), 2)).toEqual({
            results: [entry(3), pending],
            omittedCount: 1,
        });
    });

    it("retains all unresolved results beyond the history limit", () => {
        expect(appendLiveLootReviewResult([entry(2), entry(1)], entry(3), 2)).toEqual({
            results: [entry(3), entry(2), entry(1)],
            omittedCount: 0,
        });
    });

    it("retains failed captures alongside pending recognized items", () => {
        expect(appendLiveLootReviewResult([entry(2), entry(1)], entry(3, "failed"), 2)).toEqual({
            results: [entry(3, "failed"), entry(2), entry(1)],
            omittedCount: 0,
        });
    });
});

describe("acceptLiveLootReviewEntry", () => {
    it.each(["normal", "rare"] as const)("adds a recognized %s result and marks it accepted", (source) => {
        const accept = vi.fn(() => null);
        const accepted = acceptLiveLootReviewEntry({ ...entry(1), source }, accept);

        expect(accept).toHaveBeenCalledOnce();
        expect(accept).toHaveBeenCalledWith("Black Stone", 1);
        expect(accepted).toMatchObject({ accepted: true, error: "" });
    });

    it("keeps a recognized result actionable when insertion fails", () => {
        let rejected = acceptLiveLootReviewEntry(entry(1), () => "No valid price is available.");

        expect(rejected).toMatchObject({ accepted: false, error: "No valid price is available." });
        rejected = acceptLiveLootReviewEntry(rejected, () => "The local database is still loading.");
        rejected = acceptLiveLootReviewEntry(rejected, () => "The local database is still loading.");
        expect(acceptLiveLootReviewEntry(rejected, () => null)).toMatchObject({ accepted: true, error: "" });
    });

    it("does not add non-recognized results and reports thrown insertion errors", () => {
        const accept = vi.fn(() => null);
        expect(acceptLiveLootReviewEntry(entry(1, "failed"), accept)).toEqual(entry(1, "failed"));
        expect(accept).not.toHaveBeenCalled();

        const failed = acceptLiveLootReviewEntry(entry(2), () => {
            throw new Error("Ledger unavailable");
        });
        expect(failed).toMatchObject({ accepted: false, error: "Ledger unavailable" });
    });
});

describe("manual capture correction", () => {
    it("adds a failed reading once and releases its image", () => {
        const pending = entry(1, "failed");
        if (pending.result.status !== "dropped")
            pending.result.capture = {
                width: 1,
                height: 1,
                pixels: new Uint8ClampedArray(4),
            };
        const accept = vi.fn(() => null);
        const corrected = correctLiveLootReviewEntry(pending, "Black Stone", 3, accept);
        expect(accept).toHaveBeenCalledWith("Black Stone", 3);
        expect(corrected).toMatchObject({ accepted: true, result: { capture: undefined } });
        expect(correctLiveLootReviewEntry(corrected, "Black Stone", 3, accept)).toBe(corrected);
        expect(accept).toHaveBeenCalledOnce();
    });
    it("rejects a missing item without submitting", () => {
        const accept = vi.fn(() => null);
        const rejected = correctLiveLootReviewEntry(entry(1, "failed"), "  ", 1, accept);
        expect(rejected.accepted).toBe(false);
        expect(rejected.error).not.toBe("");
        expect(accept).not.toHaveBeenCalled();
    });
    it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s", (quantity) => {
        const accept = vi.fn(() => null);
        expect(correctLiveLootReviewEntry(entry(1, "failed"), "Black Stone", quantity, accept).accepted).toBe(false);
        expect(accept).not.toHaveBeenCalled();
    });
    it("preserves the capture and error for retry after insertion fails", () => {
        const pending = entry(1, "failed");
        if (pending.result.status !== "dropped")
            pending.result.capture = { width: 1, height: 1, pixels: new Uint8ClampedArray(4) };
        const rejected = correctLiveLootReviewEntry(pending, "Black Stone", 1, () => "Price unavailable");
        expect(rejected).toMatchObject({ accepted: false, error: "Price unavailable" });
        expect(rejected.result).toBe(pending.result);
        expect(correctLiveLootReviewEntry(rejected, "Black Stone", 1, () => null).accepted).toBe(true);
    });
});
