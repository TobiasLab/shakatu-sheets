import { useState } from "react";
import { Feedback } from "../../components/Feedback/Feedback";
import { QuantityImage } from "../../components/QuantityImage/QuantityImage";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
import type { QuantityExample } from "../../recognition/quantityLearning";
import styles from "./SelfImprovementSettings.module.css";
import settingsStyles from "./Settings.module.css";

function SavedExample({
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
            <div className={styles.ExampleRow}>
                <QuantityImage image={example} />
                <div className={styles.ExampleLabel}>
                    <strong>
                        {example.itemName ?? "Item not recorded"} × {example.quantity}
                    </strong>
                    <span>
                        {example.profile.font === "korean" ? "Korean" : "Strong Sword"} ·{" "}
                        {example.profile.uiScalePercent}% · {example.profile.sourceWidth} ×{" "}
                        {example.profile.sourceHeight}
                    </span>
                    <span>{new Date(example.confirmedAt).toLocaleString()}</span>
                </div>
                <button
                    className="button subtle"
                    type="button"
                    disabled={disabled}
                    onClick={onDelete}
                    aria-label={`Delete example of ${example.itemName ?? "unknown item"} × ${example.quantity}`}
                >
                    Delete
                </button>
            </div>
            {example.itemImage && (
                <QuantityImage image={example.itemImage} label={`Confirmed item: ${example.itemName}`} />
            )}
            {!example.itemImage && <p>No item-name image was available. This example only teaches the quantity.</p>}
            <details className={styles.ExampleDetails}>
                <summary>View recognition details</summary>
                <dl>
                    <div>
                        <dt>Your confirmation</dt>
                        <dd>
                            {example.itemName ?? "Item not recorded"} × {example.quantity}
                        </dd>
                    </div>
                    <div>
                        <dt>Accepted OCR quantity</dt>
                        <dd>{example.originalQuantity ?? "None — unresolved"}</dd>
                    </div>
                    <div>
                        <dt>Purpose</dt>
                        <dd>
                            {example.validation ? "Checks recognition accuracy" : "Helps recognize similar captures"}
                        </dd>
                    </div>
                </dl>
                {example.audit ? (
                    <>
                        <dl>
                            <div>
                                <dt>Crop source</dt>
                                <dd>Frame {example.audit.cropFrame.frame}</dd>
                            </div>
                            <div>
                                <dt>Original outcome</dt>
                                <dd>
                                    {example.audit.status} · {example.audit.reason.replace(/-/g, " ")}
                                </dd>
                            </div>
                            <div>
                                <dt>Event</dt>
                                <dd>{example.audit.eventId}</dd>
                            </div>
                            <div>
                                <dt>Recognition run</dt>
                                <dd>{example.audit.generation ?? "Unavailable"}</dd>
                            </div>
                            <div>
                                <dt>Session</dt>
                                <dd>{example.audit.sessionId ?? "Unavailable"}</dd>
                            </div>
                            <div>
                                <dt>Capture token / native batch</dt>
                                <dd>
                                    {example.audit.cropFrame.captureToken ?? "Unavailable"} /{" "}
                                    {example.audit.cropFrame.batchId ?? "Unavailable"}
                                </dd>
                            </div>
                        </dl>
                        <p>
                            Initial OCR evidence, before any manual retry. Readings are guesses; your confirmed item and
                            quantity are the labels used for self-improvement.
                        </p>
                        {example.audit.frames.length === 0 && (
                            <p>This capture had too few observations for an OCR attempt.</p>
                        )}
                        {example.audit.frames.map((frame) => (
                            <div className={styles.FrameEvidence} key={frame.frame}>
                                <strong>
                                    Frame {frame.frame}
                                    {frame.frame === example.audit?.cropFrame.frame ? " · Saved quantity image" : ""}
                                </strong>
                                <p>Native batch: {frame.batchId ?? "Unavailable"}</p>
                                <p>Readings used for consensus</p>
                                <pre>{frame.readings.join("\n") || "No completed reading for this frame."}</pre>
                                {frame.passes.length > 0 && (
                                    <>
                                        <p>Individual OCR passes</p>
                                        <pre>
                                            {frame.passes
                                                .map(
                                                    (pass) =>
                                                        `${pass.region} · ${pass.scale}× · threshold ${pass.threshold}: ${pass.text || "(empty)"}`,
                                                )
                                                .join("\n")}
                                        </pre>
                                    </>
                                )}
                            </div>
                        ))}
                    </>
                ) : (
                    <>
                        <p>This example predates detailed frame history.</p>
                        <p>Available OCR text</p>
                        <pre>{example.originalText || "No OCR text was available for this capture."}</pre>
                    </>
                )}
            </details>
        </li>
    );
}

export function SelfImprovementSettings({ learning }: { learning: ReturnType<typeof useSelfImprovement> }) {
    const [confirmReset, setConfirmReset] = useState(false);
    const [shown, setShown] = useState(20);
    const [examplesOpen, setExamplesOpen] = useState(false);
    const { state, ready, busy } = learning;
    return (
        <section id="self-improvement" className="panel" aria-labelledby="self-improvement-title">
            <div className="panel-heading">
                <h2 id="self-improvement-title" tabIndex={-1}>
                    Self-improvement
                </h2>
                <span className={settingsStyles.ConnectionStatus}>
                    {busy ? "Updating…" : state.enabled ? "Enabled" : "Off"}
                </span>
            </div>
            <div className={settingsStyles.SettingsForm}>
                <p>Help the app recognize loot items and quantities by confirming captures in Needs attention.</p>
                {!learning.available ? (
                    <p>Self-improvement is available in the desktop app.</p>
                ) : (
                    <>
                        <label className={styles.Option}>
                            <span>
                                <strong>Learn from my corrections</strong>
                                <small>
                                    Save item-name and quantity images with your confirmed item and number from normal
                                    drops in Needs attention.
                                </small>
                            </span>
                            <input
                                id="self-improvement-enabled"
                                type="checkbox"
                                role="switch"
                                checked={state.enabled}
                                aria-checked={state.enabled}
                                disabled={!ready || busy}
                                onChange={(event) => void learning.setSettings(event.target.checked, state.autoAllow)}
                            />
                        </label>
                        <label className={styles.Option}>
                            <span>
                                <strong>Auto allow</strong>
                                <small>
                                    Allow saved examples to recover unreadable items or quantities when the checks below
                                    pass. Otherwise, ask you to confirm.
                                </small>
                            </span>
                            <input
                                id="self-improvement-auto-allow"
                                type="checkbox"
                                role="switch"
                                checked={state.autoAllow}
                                aria-checked={state.autoAllow}
                                disabled={!ready || busy || !state.enabled}
                                onChange={(event) => void learning.setSettings(state.enabled, event.target.checked)}
                            />
                        </label>
                        <div className={styles.Note}>
                            <strong>{state.autoAllow ? "Automatic recovery" : "You confirm suggestions"}</strong>
                            <p>
                                {state.autoAllow
                                    ? learning.model.current.eligibleCount > 0
                                        ? "Some item or quantity labels meet the example checks below. Each new drop still needs agreement across at least three frames for both its item and quantity."
                                        : "Waiting for more confirmed examples. Matches stay as suggestions until the checks below pass."
                                    : "Saved examples can suggest an item and a number in Needs attention. You check both and choose Add to session."}
                            </p>
                        </div>
                        <p>
                            Images and corrections stay on this device. Item names and whole quantities are learned
                            independently for your font, UI scale, and resolution. Older examples have no confirmed item
                            image.
                        </p>
                        <details className={styles.Library}>
                            <summary>Automatic recovery checks</summary>
                            <div className={styles.LibraryBody}>
                                <p>
                                    For each learned label: at least 2 distinct matching templates, at least 3 reserved
                                    examples all recognized correctly, and at least 1 correctly recognized reserved
                                    example of a different label. Any wrong reserved prediction blocks that type of
                                    learning for the display setup.
                                </p>
                                <p>
                                    Every new drop needs at least 3 agreeing frames for both item and quantity. A field
                                    can come from eligible learned images or clear OCR. Conflicting OCR blocks automatic
                                    recovery. Learned items must belong to the current item list.
                                </p>
                                <p>
                                    These are conservative example checks, not a measured gameplay accuracy guarantee.
                                    Similar captures can share the same errors. Older quantity-only Auto allow settings
                                    were turned off when item learning was added.
                                </p>
                                {learning.model.current.evidence.map((entry) => (
                                    <div
                                        className={styles.FrameEvidence}
                                        key={`${entry.kind}/${entry.label}/${entry.profile.font}/${entry.profile.uiScalePercent}/${entry.profile.sourceWidth}/${entry.profile.sourceHeight}`}
                                    >
                                        <strong>
                                            {entry.kind === "item" ? "Item" : "Quantity"}: {entry.label} —{" "}
                                            {entry.eligible ? "Example checks met" : "Confirmation required"}
                                        </strong>
                                        <p>
                                            {entry.profile.font} · {entry.profile.uiScalePercent}% ·{" "}
                                            {entry.profile.sourceWidth} × {entry.profile.sourceHeight}
                                        </p>
                                        <p>
                                            {entry.templates} templates · {entry.correct}/{entry.checked} reserved
                                            examples correct · {entry.alternativesCorrect} other-label examples correct
                                            · {entry.wrong} wrong predictions in this setup
                                        </p>
                                    </div>
                                ))}
                                {learning.model.current.evidence.length === 0 && <p>No active learning examples.</p>}
                            </div>
                        </details>
                        {learning.error && <Feedback tone="error">{learning.error}</Feedback>}
                        {learning.message && !learning.error && <Feedback tone="success">{learning.message}</Feedback>}
                        {!ready && !busy && (
                            <button className="button" type="button" onClick={() => void learning.reload()}>
                                Retry loading self-improvement
                            </button>
                        )}
                        {learning.failedExample && (
                            <div className={styles.Note}>
                                <strong>
                                    {learning.failedExampleCount} unsaved{" "}
                                    {learning.failedExampleCount === 1 ? "example" : "examples"}
                                </strong>
                                <p>
                                    Your drops were added to the session. Retry saving their examples before closing the
                                    app.
                                </p>
                                <div className={styles.Actions}>
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
                            </div>
                        )}
                        <details
                            className={styles.Library}
                            id="self-improvement-examples"
                            onToggle={(event) => setExamplesOpen(event.currentTarget.open)}
                        >
                            <summary>
                                Saved examples <span>{state.examples.length}</span>
                            </summary>
                            <div className={styles.LibraryBody}>
                                {state.examples.length === 0 ? (
                                    <p>
                                        No examples yet. Enable self-improvement, then confirm a normal-loot capture in
                                        Needs attention to get started.
                                    </p>
                                ) : (
                                    <>
                                        <p>
                                            Check what the app has learned, or delete an example with an incorrect item
                                            or number. Some examples are kept aside to check recognition accuracy.
                                        </p>
                                        {examplesOpen && (
                                            <ul className={styles.Examples} aria-label="Saved correction examples">
                                                {state.examples.slice(0, shown).map((example) => (
                                                    <SavedExample
                                                        key={example.id}
                                                        example={example}
                                                        disabled={busy}
                                                        onDelete={() => void learning.deleteExample(example.id)}
                                                    />
                                                ))}
                                            </ul>
                                        )}
                                        {shown < state.examples.length && (
                                            <button
                                                className="button"
                                                type="button"
                                                onClick={() => setShown(shown + 20)}
                                            >
                                                Show more examples
                                            </button>
                                        )}
                                    </>
                                )}
                                <p>
                                    Keeps up to 50 examples per display setup and 200 overall. Older examples are
                                    replaced as new ones arrive. Turning self-improvement off keeps your saved examples.
                                </p>
                                {confirmReset ? (
                                    <div className={styles.Note}>
                                        <p>
                                            Delete all saved examples and turn self-improvement off? Your sessions will
                                            stay unchanged.
                                        </p>
                                        <div className={styles.Actions}>
                                            <button
                                                className="button"
                                                type="button"
                                                disabled={busy}
                                                onClick={() => setConfirmReset(false)}
                                            >
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
                                    </div>
                                ) : (
                                    <button
                                        className="button subtle"
                                        type="button"
                                        disabled={!ready || busy}
                                        onClick={() => setConfirmReset(true)}
                                    >
                                        Reset self-improvement
                                    </button>
                                )}
                            </div>
                        </details>
                    </>
                )}
            </div>
        </section>
    );
}
