import { describe, expect, it, vi } from "vitest";
import type { LiveLootRecognitionResult } from "./liveLoot";
import { acceptLiveLootReviewEntry, appendLiveLootReviewResult, type LiveLootReviewEntry } from "./liveLootReview";

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

    it("evicts non-actionable history before unresolved recognized results", () => {
        const failed = entry(1, "failed");
        const pending = entry(2);
        expect(appendLiveLootReviewResult([pending, failed], entry(3), 2)).toEqual({
            results: [entry(3), pending],
            omittedCount: 1,
        });
    });

    it("reports when the oldest unresolved recognized result must be omitted", () => {
        expect(appendLiveLootReviewResult([entry(2), entry(1)], entry(3), 2)).toEqual({
            results: [entry(3), entry(2)],
            omittedCount: 1,
        });
    });

    it("retains a new non-actionable result so it can be reported", () => {
        expect(appendLiveLootReviewResult([entry(2), entry(1)], entry(3, "failed"), 2)).toEqual({
            results: [entry(3, "failed"), entry(2)],
            omittedCount: 1,
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
