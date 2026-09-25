import { useEffect, useRef, useState } from "react";
import type { LootRoiFrame } from "../../recognition/liveLoot";
import type { QuantityExample } from "../../recognition/quantityLearning";
import styles from "./QuantityLearningPanel.module.css";
import type { useQuantityLearning } from "./useQuantityLearning";

export function QuantityImage({
    image,
}: {
    image: Pick<LootRoiFrame, "width" | "height"> & { pixels: ArrayLike<number> };
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const context = canvas.current?.getContext("2d");
        if (!context) return;
        const data = context.createImageData(image.width, image.height);
        data.data.set(Array.from(image.pixels));
        context.putImageData(data, 0, 0);
    }, [image]);
    return (
        <canvas
            className={styles.QuantityImage}
            ref={canvas}
            width={image.width}
            height={image.height}
            aria-label="Quantity image for learning"
        />
    );
}

function Example({
    example,
    disabled,
    onDelete,
}: {
    example: QuantityExample;
    disabled: boolean;
    onDelete: () => void;
}) {
    return (
        <li className={styles.Example}>
            <QuantityImage image={example} />
            <span>
                <strong>Confirmed quantity: {example.quantity}</strong>
                <small>
                    {example.profile.font === "korean" ? "Korean" : "Strong Sword"} · {example.profile.uiScalePercent}%
                    · {example.profile.sourceWidth} × {example.profile.sourceHeight}
                </small>
                <small>
                    {example.validation ? "Reserved for validation" : "Used for matching"} ·{" "}
                    {new Date(example.confirmedAt).toLocaleString()}
                </small>
            </span>
            <button
                className="button subtle"
                type="button"
                disabled={disabled}
                onClick={onDelete}
                aria-label={`Delete example of quantity ${example.quantity}`}
            >
                Delete
            </button>
        </li>
    );
}

export function QuantityLearningPanel({ learning }: { learning: ReturnType<typeof useQuantityLearning> }) {
    const [confirmReset, setConfirmReset] = useState(false);
    const [shown, setShown] = useState(20);
    const [open, setOpen] = useState(false);
    if (!learning.available) return null;
    const { state, ready, busy } = learning;
    return (
        <details className={styles.Panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>
                Quantity learning
                {learning.error
                    ? " · Needs attention"
                    : state.enabled
                      ? ` · ${state.examples.length} ${state.examples.length === 1 ? "example" : "examples"}`
                      : " · Off"}
            </summary>
            <div className={styles.Body}>
                <label className={styles.Option}>
                    <input
                        type="checkbox"
                        checked={state.enabled}
                        disabled={!ready || busy}
                        onChange={(event) => void learning.setSettings(event.target.checked, state.autoAllow)}
                    />
                    Learn from Needs attention corrections
                </label>
                <p>
                    When you add a corrected normal drop, save its small quantity image and confirmed number on this
                    device. Nothing is uploaded. Whole quantities are learned separately for each font, UI scale, and
                    capture resolution.
                </p>
                <label className={styles.Option}>
                    <input
                        type="checkbox"
                        checked={state.autoAllow}
                        disabled={!ready || busy || !state.enabled}
                        onChange={(event) => void learning.setSettings(state.enabled, event.target.checked)}
                    />
                    Auto allow validated quantity matches
                </label>
                <p>
                    Off by default: you confirm suggestions. When enabled, automatic recovery requires successful checks
                    on reserved examples, a clear item, and matching quantities across at least three frames. Existing
                    accepted OCR quantities stay unchanged. Automatic recoveries never teach the reader.
                </p>
                {state.autoAllow && (
                    <p role="status">
                        {learning.model.current.eligibleCount} quantity/setup combinations currently eligible. Other
                        matches remain suggestions.
                    </p>
                )}
                {learning.error && <p role="alert">{learning.error}</p>}
                {learning.message && <p role="status">{learning.message}</p>}
                {!ready && !busy && (
                    <button className="button" type="button" onClick={() => void learning.reload()}>
                        Retry loading learning data
                    </button>
                )}
                {learning.failedExample && (
                    <div className={styles.Actions}>
                        <span>
                            {learning.failedExampleCount} learning examples could not be saved. The drops were added to
                            the session.
                        </span>
                        <button
                            className="button"
                            type="button"
                            disabled={busy || !state.enabled}
                            onClick={learning.retrySave}
                        >
                            Retry saving example
                        </button>
                        <button
                            className="button subtle"
                            type="button"
                            disabled={busy}
                            onClick={learning.discardFailedSave}
                        >
                            Discard unsaved example
                        </button>
                    </div>
                )}
                <p>
                    Stores up to 50 examples per setup and 200 overall, replacing the oldest. Every third new example is
                    reserved for validation.
                </p>
                {open && state.examples.length > 0 && (
                    <>
                        <ul className={styles.Examples} aria-label="Saved quantity examples">
                            {state.examples.slice(0, shown).map((example) => (
                                <Example
                                    key={example.id}
                                    example={example}
                                    disabled={busy}
                                    onDelete={() => void learning.deleteExample(example.id)}
                                />
                            ))}
                        </ul>
                        {shown < state.examples.length && (
                            <button className="button" type="button" onClick={() => setShown(shown + 20)}>
                                Show more examples
                            </button>
                        )}
                    </>
                )}
                {confirmReset ? (
                    <div className={styles.Actions}>
                        <p>Delete all learning examples and turn learning off? Your sessions will stay unchanged.</p>
                        <button className="button" type="button" disabled={busy} onClick={() => setConfirmReset(false)}>
                            Keep examples
                        </button>
                        <button
                            className="button"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setConfirmReset(false);
                                void learning.reset();
                            }}
                        >
                            Delete all examples
                        </button>
                    </div>
                ) : (
                    <button
                        className="button subtle"
                        type="button"
                        disabled={!ready || busy}
                        onClick={() => setConfirmReset(true)}
                    >
                        Reset quantity learning
                    </button>
                )}
            </div>
        </details>
    );
}
