import { analyzeLootReadings, type LootReviewCapture } from "./liveLoot";
import { createLiveLootTesseractOcr, type LiveLootTesseractOcr } from "./liveLootOcr";

/** A one-frame suggestion for human review, independent of live capture's temporal consensus. */
export async function retryLootCapture(
    capture: LootReviewCapture,
    source: "normal" | "rare",
    dictionary: readonly string[],
    signal: AbortSignal,
    createOcr: () => Promise<LiveLootTesseractOcr> = createLiveLootTesseractOcr,
) {
    signal.throwIfAborted();
    const ocr = await createOcr();
    let suggestion: { item: string; quantity: number } | null;
    try {
        signal.throwIfAborted();
        const readings = await ocr.readText(
            [
                {
                    frame: 0,
                    roi: capture,
                    observation: {
                        slot: 0,
                        centerY: Math.floor(capture.height / 2),
                        score: 1,
                        fingerprint: { full: new Uint8Array(), quantity: new Uint8Array() },
                    },
                    bounds: capture.bounds ?? { left: 0, right: capture.width, top: 0, bottom: capture.height },
                    textColor: source === "rare" ? "gold" : "white",
                },
            ],
            signal,
        );
        signal.throwIfAborted();
        suggestion = analyzeLootReadings(readings, dictionary).consensus;
    } catch (error) {
        await ocr.terminate().catch(() => {
            // Preserve the original OCR or cancellation error if cleanup also fails.
        });
        throw error;
    }
    await ocr.terminate();
    signal.throwIfAborted();
    return suggestion;
}
