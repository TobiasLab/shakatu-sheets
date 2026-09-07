import { useEffect, useRef, useState } from "react";
import type { LiveLootReviewEntry } from "../../recognition/liveLootReview";
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
