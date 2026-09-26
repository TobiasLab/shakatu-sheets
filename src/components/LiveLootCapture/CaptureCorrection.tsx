import { useEffect, useRef, useState } from "react";
import type { LiveLootReviewEntry } from "../../recognition/liveLootReview";
import { itemImage, quantityImage } from "../../recognition/quantityLearning";
import { retryLootCapture } from "../../recognition/retryLootCapture";
import { FormField } from "../FormField/FormField";
import { QuantityImage } from "../QuantityImage/QuantityImage";
import styles from "./LootReview.module.css";

export type CorrectionDraft = { item: string; quantity: string };

export function CaptureCorrection({
    review,
    items,
    disabled,
    onAdd,
    draft,
    onDraftChange,
    learnOnAdd = false,
    learnedQuantity,
    learnedItem,
}: {
    review: LiveLootReviewEntry;
    items: readonly string[];
    disabled: boolean;
    draft: CorrectionDraft;
    onDraftChange: (draft: CorrectionDraft) => void;
    onAdd: (id: number, itemName: string, quantity: number) => void;
    learnOnAdd?: boolean;
    learnedQuantity?: number;
    learnedItem?: string;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const { item, quantity } = draft;
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
                    <div className={styles.CaptureImage}>
                        <canvas ref={canvas} aria-label="Unrecognized item capture" />
                    </div>
                </figure>
            ) : (
                <p className={styles.Unavailable}>No image was available for this notification.</p>
            )}
            {retryMessage && (
                <div className={styles.RetryResult}>
                    <p role="status">{retryMessage}</p>
                    {suggestion && (
                        <>
                            <strong>
                                {suggestion.item} × {suggestion.quantity}
                            </strong>
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
                        </>
                    )}
                </div>
            )}
            {learnedItem !== undefined && (
                <div className={styles.RetryResult}>
                    <p>
                        Saved examples suggest <strong>{learnedItem}</strong>. Check the item name against the capture.
                    </p>
                    <button
                        className="button"
                        type="button"
                        disabled={disabled}
                        onClick={() => onDraftChange({ ...draft, item: learnedItem })}
                    >
                        Use learned item
                    </button>
                </div>
            )}
            {learnedQuantity !== undefined && (
                <div className={styles.RetryResult}>
                    <p>
                        Saved examples suggest quantity <strong>{learnedQuantity}</strong>. Check the image before
                        confirming.
                    </p>
                    <button
                        className="button"
                        type="button"
                        disabled={disabled}
                        onClick={() => onDraftChange({ ...draft, quantity: String(learnedQuantity) })}
                    >
                        Use learned quantity
                    </button>
                </div>
            )}
            {learningImage && (
                <div className={styles.RetryResult}>
                    {learningItemImage && (
                        <QuantityImage image={learningItemImage} label="Item name image for self-improvement" />
                    )}
                    <QuantityImage image={learningImage} />
                    <p>
                        Self-improvement is on. Adding this drop saves your confirmed item and quantity with the images
                        shown here. Check that each image contains the complete text.
                        {!learningItemImage &&
                            " The item name could not be isolated; only the quantity image will be learned."}
                    </p>
                </div>
            )}
            <div className={styles.CorrectionFields}>
                <FormField label="Item">
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
                <FormField label="Quantity">
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
            </div>
            <div className={styles.CorrectionActions}>
                <button className="button primary-button" type="submit" disabled={disabled}>
                    Add to session
                </button>
            </div>
        </form>
    );
}
