import type {
    LiveLootOcrReader,
    LiveLootRecognitionResult,
    LootOcrBounds,
    LootOcrPass,
    LootRoiFrame,
} from "./liveLoot";

type RoiSampleReference = NonNullable<LootRoiFrame["sample"]>;
type DiagnosticFrame = {
    frame: number | null;
    batchId: number | null;
    readings: string[];
    centerY?: number;
    bounds?: LootOcrBounds;
    quantityBounds?: LootOcrBounds;
    textColor?: "white" | "gold";
    passes?: LootOcrPass[];
};
export type RoiOcrIssue = {
    captureToken: number;
    collectionPath: string;
    source: "normal" | "rare";
    generation: number;
    eventId: string | null;
    status: LiveLootRecognitionResult["status"];
    itemName: string | null;
    quantity: number | null;
    reason: LiveLootRecognitionResult["reason"] | "frame-analysis-failure" | "ocr-startup-failure";
    firstFrame: DiagnosticFrame;
    selectedFrames: DiagnosticFrame[];
    lastFrame: DiagnosticFrame | null;
    count: number;
    error: string | null;
};

// Metadata only: bounded to slightly more than a 30-minute, 16 FPS collection. No pixels are retained here.
export class RoiOcrDiagnostics {
    private nextFrame = 0;
    private readonly samples = new Map<number, RoiSampleReference>();
    private readonly readings = new Map<number, Partial<DiagnosticFrame>>();
    private readonly errors = new Map<number, string>();

    constructor(
        private readonly source: "normal" | "rare",
        private readonly generation: number,
        private readonly emit: (issue: RoiOcrIssue) => void,
    ) {}

    observe(frame: LootRoiFrame) {
        const index = this.nextFrame++;
        if (!frame.sample) return;
        this.samples.set(index, frame.sample);
        if (this.samples.size > 32_768) {
            const oldest = this.samples.keys().next().value;
            if (oldest !== undefined) this.samples.delete(oldest);
        }
    }

    wrap(reader: LiveLootOcrReader): LiveLootOcrReader {
        return async (frames, signal) => {
            for (const frame of frames) {
                if (this.samples.has(frame.frame)) frame.diagnostics = { passes: [] };
            }
            try {
                const result = await reader(frames, signal);
                frames.forEach((frame, index) => {
                    if (this.samples.has(frame.frame))
                        this.readings.set(frame.frame, {
                            readings: (result[index] ?? []).slice(0, 3).map((text) => text.slice(0, 512)),
                        });
                });
                return result;
            } catch (error) {
                for (const frame of frames) {
                    if (this.samples.has(frame.frame)) this.errors.set(frame.frame, String(error).slice(0, 1024));
                }
                throw error;
            } finally {
                for (const frame of frames) {
                    if (this.samples.has(frame.frame))
                        this.readings.set(frame.frame, {
                            ...this.readings.get(frame.frame),
                            centerY: frame.observation.centerY,
                            bounds: frame.bounds,
                            quantityBounds: frame.observation.fingerprint.digits?.bounds,
                            textColor: frame.textColor ?? "white",
                            passes: frame.diagnostics?.passes
                                .slice(0, 9)
                                .map((pass) => ({ ...pass, text: pass.text.slice(0, 512) })),
                        });
                }
                for (const map of [this.readings, this.errors]) {
                    while (map.size > 128) {
                        const oldest = map.keys().next().value;
                        if (oldest !== undefined) map.delete(oldest);
                    }
                }
            }
        };
    }

    result(result: LiveLootRecognitionResult) {
        let reference =
            (result.status === "dropped" ? this.samples.get(result.lastFrame) : undefined) ??
            this.samples.get(result.firstFrame);
        // Selected frames are chronological; prefer the latest run when an event spans collections.
        for (const frame of result.selectedFrames) reference = this.samples.get(frame) ?? reference;
        if (reference) {
            const describe = (frame: number): DiagnosticFrame => {
                const sample = this.samples.get(frame);
                return {
                    frame,
                    batchId:
                        sample?.collectionPath === reference.collectionPath &&
                        sample.captureToken === reference.captureToken
                            ? sample.batchId
                            : null,
                    readings: [],
                    ...this.readings.get(frame),
                };
            };
            this.emit({
                captureToken: reference.captureToken,
                collectionPath: reference.collectionPath,
                source: this.source,
                generation: this.generation,
                eventId: result.eventId,
                status: result.status,
                itemName: result.itemName,
                quantity: result.quantity,
                reason: result.reason,
                firstFrame: describe(result.firstFrame),
                selectedFrames: result.selectedFrames.map(describe),
                lastFrame: result.status === "dropped" ? describe(result.lastFrame) : null,
                count: result.status === "dropped" ? result.count : 1,
                error:
                    result.selectedFrames.map((frame) => this.errors.get(frame)).find((error) => error !== undefined) ??
                    null,
            });
        }
        for (const frame of result.selectedFrames) {
            this.readings.delete(frame);
            this.errors.delete(frame);
        }
    }

    frameFailure(error: unknown) {
        const frame = this.nextFrame - 1;
        const sample = this.samples.get(frame);
        if (sample)
            this.emit(roiOcrFailure(sample, this.source, this.generation, "frame-analysis-failure", error, frame));
    }
}

export function roiOcrFailure(
    sample: RoiSampleReference,
    source: "normal" | "rare",
    generation: number,
    reason: "frame-analysis-failure" | "ocr-startup-failure",
    error: unknown,
    frame: number | null = null,
): RoiOcrIssue {
    return {
        captureToken: sample.captureToken,
        collectionPath: sample.collectionPath,
        source,
        generation,
        eventId: null,
        status: "failed",
        itemName: null,
        quantity: null,
        reason,
        firstFrame: { frame, batchId: sample.batchId, readings: [] },
        selectedFrames: [],
        lastFrame: null,
        count: 1,
        error: String(error).slice(0, 1024),
    };
}
