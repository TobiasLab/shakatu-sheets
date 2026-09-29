import { useEffect, useRef, useState } from "react";
import type { LiveLootReviewEntry } from "../../recognition/liveLootReview";
import { itemImage, quantityImage } from "../../recognition/quantityLearning";
import { retryLootCapture } from "../../recognition/retryLootCapture";
import { FormField } from "../FormField/FormField";
import { QuantityImage } from "../QuantityImage/QuantityImage";
import styles from "./LootReview.module.css";

export type CorrectionDraft = {
    item: string;
    quantity: string;
    learnedItem?: string;
    learnedQuantity?: number;
};

export function CaptureCorrection({
    review,
    items,
    disabled,
    onAdd,
    draft,
    onDraftChange,
    learnOnAdd = false,
}: {
    review: LiveLootReviewEntry;
    items: readonly string[];
    disabled: boolean;
    draft: CorrectionDraft;
    onDraftChange: (draft: CorrectionDraft) => void;
    onAdd: (id: number, itemName: string, quantity: number) => void;
    learnOnAdd?: boolean;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const { item, quantity, learnedItem, learnedQuantity } = draft;
    const capture = review.result.status === "dropped" ? undefined : review.result.capture;
    const learningImage = learnOnAdd && review.source === "normal" ? quantityImage(capture) : undefined;
    const learningItemImage = learningImage ? itemImage(capture) : undefined;
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
            const result = await retryLootCapture(
                capture,
                review.source,
                items,
                controller.signal,
                undefined,
                review.font,
            );
            if (controller.signal.aborted) return;
            setSuggestion(result);
            setRetryMessage(result ? "" : "OCR could not read a clear item and quantity.");
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
                <figure className={styles.Capture}>
                    <figcaption>
                        <span>Saved capture</span>
                        <button
                            className="button subtle"
                            type="button"
                            disabled={disabled || retrying}
                            onClick={() => void retryOcr()}
                        >
                            {retrying ? "Reading capture…" : "Retry OCR"}
                        </button>
                    </figcaption>
                    <canvas ref={canvas} aria-label="Unrecognized item capture" />
                </figure>
            ) : (
                <p className={styles.Unavailable}>No image was available for this notification.</p>
            )}
            {learningImage && (
                <div className={styles.Learning}>
                    <span>{learningItemImage ? "Saved for learning" : "Saved for learning · quantity only"}</span>
                    {learningItemImage && (
                        <QuantityImage image={learningItemImage} label="Item name image for self-improvement" />
                    )}
                    <QuantityImage image={learningImage} />
                </div>
            )}
            {(suggestion || retryMessage) && (
                <div className={styles.RetryResult}>
                    <p role="status">
                        {suggestion ? (
                            <>
                                OCR suggests{" "}
                                <strong>
                                    {suggestion.item} × {suggestion.quantity}
                                </strong>
                            </>
                        ) : (
                            retryMessage
                        )}
                    </p>
                    {suggestion && (
                        <button
                            className="button"
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                                onDraftChange({ item: suggestion.item, quantity: String(suggestion.quantity) })
                            }
                        >
                            Use suggestion
                        </button>
                    )}
                </div>
            )}
            <div className={styles.CorrectionFields}>
                <FormField
                    className={styles.ItemField}
                    label={
                        <>
                            Item
                            {item !== "" && item === learnedItem && <span className={styles.Suggested}>Suggested</span>}
                        </>
                    }
                >
                    <select
                        required
                        value={item}
                        disabled={disabled}
                        onChange={(event) => onDraftChange({ ...draft, item: event.target.value })}
                    >
                        <option value="">Choose item…</option>
                        {items.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </FormField>
                <FormField
                    className={styles.QuantityField}
                    label={
                        <>
                            Quantity
                            {learnedQuantity !== undefined && quantity === String(learnedQuantity) && (
                                <span className={styles.Suggested}>Suggested</span>
                            )}
                        </>
                    }
                >
                    <input
                        type="number"
                        min="1"
                        step="1"
                        max={Number.MAX_SAFE_INTEGER}
                        required
                        value={quantity}
                        disabled={disabled}
                        onChange={(event) => onDraftChange({ ...draft, quantity: event.target.value })}
                    />
                </FormField>
                <button className="button primary-button" type="submit" disabled={disabled}>
                    Add to session
                </button>
            </div>
        </form>
    );
}
