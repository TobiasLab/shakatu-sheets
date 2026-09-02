import { describe, expect, it } from "vitest";
import type { LiveLootRecognitionResult } from "./liveLoot";
import { appendLiveLootReviewResult, type LiveLootReviewEntry } from "./liveLootReview";

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
    return { id, result, accepted: false, error: "" };
}

describe("appendLiveLootReviewResult", () => {
    it("prepends results within the configured bound", () => {
        expect(appendLiveLootReviewResult([entry(1)], entry(2), 2)).toEqual({
            results: [entry(2), entry(1)],
            omittedCount: 0,
        });
    });

    it("evicts non-actionable history before pending recognized results", () => {
        const failed = entry(1, "failed");
        const pending = entry(2);
        expect(appendLiveLootReviewResult([pending, failed], entry(3), 2)).toEqual({
            results: [entry(3), pending],
            omittedCount: 1,
        });
    });

    it("reports when the oldest pending recognized result must be omitted", () => {
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
