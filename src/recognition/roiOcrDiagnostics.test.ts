import { describe, expect, it } from "vitest";
import type { LiveLootOcrFrame, LiveLootRecognitionResult, LootRoiFrame } from "./liveLoot";
import { RoiOcrDiagnostics, type RoiOcrIssue, roiOcrFailure } from "./roiOcrDiagnostics";

function frame(batchId?: number, collectionPath = "/run-1"): LootRoiFrame {
    return {
        width: 1,
        height: 1,
        pixels: new Uint8ClampedArray(4),
        sample: batchId === undefined ? undefined : { batchId, collectionPath, captureToken: 9 },
    };
}
function ocrFrame(index: number): LiveLootOcrFrame {
    return {
        frame: index,
        roi: frame(),
        observation: {
            slot: 0,
            centerY: 10,
            score: 300,
            fingerprint: { full: new Uint8Array(), quantity: new Uint8Array() },
        },
    };
}
function withheld(
    firstFrame: number,
    selectedFrames: number[] = [],
): Extract<LiveLootRecognitionResult, { status: "withheld" }> {
    return {
        eventId: "loot-1",
        firstFrame,
        selectedFrames,
        status: "withheld",
        reason: "consensus-withheld",
        itemName: null,
        quantity: null,
    };
}
function recorder(source: "normal" | "rare" = "normal") {
    const issues: RoiOcrIssue[] = [];
    return { issues, diagnostics: new RoiOcrDiagnostics(source, 3, (issue) => issues.push(issue)) };
}

describe("ROI OCR diagnostics", () => {
    it("does not log uncollected frames or successful recognition", () => {
        const { diagnostics, issues } = recorder();
        diagnostics.observe(frame());
        diagnostics.result(withheld(0));
        diagnostics.frameFailure(new Error("analysis"));
        diagnostics.observe(frame(22));
        diagnostics.result({ ...withheld(1), status: "recognized", reason: null, itemName: "Loot", quantity: 1 });
        expect(issues).toEqual([]);
    });

    it.each(["normal", "rare"] as const)(
        "links %s internal indices to native batch IDs across collection gaps",
        async (source) => {
            const { diagnostics, issues } = recorder(source);
            diagnostics.observe(frame());
            diagnostics.observe(frame(101));
            diagnostics.observe(frame(109));
            const reader = diagnostics.wrap(async () => [["Item x1"], ["Itern x7"]]);
            await reader([ocrFrame(1), ocrFrame(2)], new AbortController().signal);
            diagnostics.result(withheld(0, [1, 2]));
            expect(issues[0]).toMatchObject({
                source,
                generation: 3,
                reason: "consensus-withheld",
                firstFrame: { frame: 0, batchId: null, readings: [] },
                selectedFrames: [
                    { frame: 1, batchId: 101, readings: ["Item x1"] },
                    { frame: 2, batchId: 109, readings: ["Itern x7"] },
                ],
            });
        },
    );

    it("records failed OCR errors and clears readings between jobs sharing frames", async () => {
        const { diagnostics, issues } = recorder();
        diagnostics.observe(frame(1));
        await diagnostics.wrap(async () => [["first row"]])([ocrFrame(0)], new AbortController().signal);
        diagnostics.result(withheld(0, [0]));
        const reader = diagnostics.wrap(async () => {
            throw new Error("worker crashed");
        });
        await expect(reader([ocrFrame(0)], new AbortController().signal)).rejects.toThrow("worker crashed");
        diagnostics.result({ ...withheld(0, [0]), status: "failed", reason: "ocr-failure" });
        expect(issues[1]).toMatchObject({
            error: "Error: worker crashed",
            selectedFrames: [{ batchId: 1, readings: [] }],
        });
    });

    it("does not label another collection's frame as belonging to the chosen run", () => {
        const { diagnostics, issues } = recorder();
        diagnostics.observe(frame(1));
        diagnostics.observe(frame(2, "/run-2"));
        diagnostics.result(withheld(0, [1]));
        expect(issues[0]).toMatchObject({
            collectionPath: "/run-2",
            firstFrame: { batchId: null },
            selectedFrames: [{ batchId: 2 }],
        });
    });

    it("routes events spanning collections to the latest selected sample run", () => {
        const { diagnostics, issues } = recorder();
        diagnostics.observe(frame(1));
        diagnostics.observe(frame(2, "/run-2"));
        diagnostics.result(withheld(0, [0, 1]));
        expect(issues[0]).toMatchObject({
            collectionPath: "/run-2",
            firstFrame: { batchId: null },
            selectedFrames: [{ batchId: null }, { batchId: 2 }],
        });
    });

    it("reports insufficient observations, dropped results, and frame-analysis failures", () => {
        const { diagnostics, issues } = recorder();
        diagnostics.observe(frame(7));
        diagnostics.result({ ...withheld(0), reason: "insufficient-observations" });
        diagnostics.result({
            eventId: null,
            firstFrame: 0,
            lastFrame: 0,
            selectedFrames: [],
            itemName: null,
            quantity: null,
            status: "dropped",
            reason: "backpressure-summary",
            count: 3,
            backpressureCount: 3,
            resultOverflowCount: 0,
            firstEventId: "a",
            lastEventId: "c",
        });
        diagnostics.frameFailure("invalid pixels");
        expect(issues.map((issue) => [issue.reason, issue.count])).toEqual([
            ["insufficient-observations", 1],
            ["backpressure-summary", 3],
            ["frame-analysis-failure", 1],
        ]);
        expect(issues[2].firstFrame.batchId).toBe(7);
    });

    it("bounds retained provenance and raw strings", async () => {
        const { diagnostics, issues } = recorder();
        for (let index = 0; index < 16_385; index++) diagnostics.observe(frame(index));
        diagnostics.result(withheld(0));
        expect(issues).toEqual([]);
        await diagnostics.wrap(async () => [Array(4).fill("x".repeat(600))])(
            [ocrFrame(16_384)],
            new AbortController().signal,
        );
        diagnostics.result(withheld(16_384, [16_384]));
        expect(issues[0].selectedFrames[0].readings).toEqual(Array(3).fill("x".repeat(512)));
    });

    it("records startup failure against a sample without inventing a coordinator index", () => {
        expect(
            roiOcrFailure(
                { captureToken: 9, collectionPath: "/run", batchId: 12 },
                "rare",
                4,
                "ocr-startup-failure",
                "worker missing",
            ),
        ).toMatchObject({
            reason: "ocr-startup-failure",
            firstFrame: { frame: null, batchId: 12 },
            error: "worker missing",
        });
    });
});
