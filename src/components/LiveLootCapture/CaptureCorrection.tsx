import { useEffect, useRef, useState } from "react";
import type { LiveLootReviewEntry } from "../../recognition/liveLootReview";
import { retryLootCapture } from "../../recognition/retryLootCapture";
import styles from "./LiveLootCapture.module.css";

export function CaptureCorrection({
    review,
    items,
    disabled,
    onAdd,
}: {
    review: LiveLootReviewEntry;
    items: readonly string[];
    disabled: boolean;
    onAdd: (id: number, itemName: string, quantity: number) => void;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [item, setItem] = useState("");
    const [quantity, setQuantity] = useState("1");
    const capture = review.result.status === "dropped" ? undefined : review.result.capture;
    const retry = useRef<AbortController | null>(null);
    const [retrying, setRetrying] = useState(false);
    const [retryMessage, setRetryMessage] = useState("");
    const [suggestion, setSuggestion] = useState<{ item: string; quantity: number } | null>(null);
    useEffect(
        () => () => {
            retry.current?.abort();
            retry.current = null;
        },
        [],
    );

    async function retryOcr() {
        if (!capture || disabled || retry.current) return;
        const controller = new AbortController();
        retry.current = controller;
        setRetrying(true);
        setRetryMessage("");
        setSuggestion(null);
        try {
            const result = await retryLootCapture(capture, review.source, items, controller.signal);
            if (controller.signal.aborted) return;
            setSuggestion(result);
            setRetryMessage(
                result
                    ? "Check the suggestion against the image before adding it."
                    : "OCR could not read a clear item and quantity. You can still add this capture manually.",
            );
        } catch (error) {
            if (!controller.signal.aborted)
                setRetryMessage(`OCR retry failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (!controller.signal.aborted) {
                retry.current = null;
                setRetrying(false);
            }
        }
    }

    useEffect(() => {
        if (!capture || !canvas.current) return;
        canvas.current.width = capture.width;
        canvas.current.height = capture.height;
        const context = canvas.current.getContext("2d");
        if (!context) return;
        const pixels = context.createImageData(capture.width, capture.height);
        pixels.data.set(capture.pixels);
        context.putImageData(pixels, 0, 0);
    }, [capture]);
    return (
        <form
            className={styles.Correction}
            onSubmit={(event) => {
                event.preventDefault();
                onAdd(review.id, item, Number(quantity));
            }}
        >
            {capture ? (
                <canvas ref={canvas} aria-label="Unrecognized item capture" />
            ) : (
                <small>No image was available for this notification.</small>
            )}
            {capture && (
                <div className={styles.CorrectionFields}>
                    <button
                        className="button"
                        type="button"
                        disabled={disabled || retrying}
                        onClick={() => void retryOcr()}
                    >
                        {retrying ? "Reading capture…" : "Retry OCR"}
                    </button>
                    {suggestion && (
                        <>
                            <strong>
                                {suggestion.item} × {suggestion.quantity}
                            </strong>
                            <button
                                className="button"
                                type="button"
                                disabled={disabled}
                                onClick={() => onAdd(review.id, suggestion.item, suggestion.quantity)}
                            >
                                Add OCR result
                            </button>
                        </>
                    )}
                    <small role="status">{retrying ? "Reading this saved image only…" : retryMessage}</small>
                </div>
            )}
            <div className={styles.CorrectionFields}>
                <label>
                    Item
                    <select required value={item} disabled={disabled} onChange={(event) => setItem(event.target.value)}>
                        <option value="">Choose item…</option>
                        {items.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Quantity
                    <input
                        type="number"
                        min="1"
                        step="1"
                        max={Number.MAX_SAFE_INTEGER}
                        required
                        value={quantity}
                        disabled={disabled}
                        onChange={(event) => setQuantity(event.target.value)}
                    />
                </label>
                <button className="button" type="submit" disabled={disabled}>
                    Add to session
                </button>
            </div>
        </form>
    );
}
