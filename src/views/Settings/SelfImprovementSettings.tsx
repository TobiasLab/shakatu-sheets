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
                    <strong>Confirmed quantity: {example.quantity}</strong>
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
                    aria-label={`Delete example of quantity ${example.quantity}`}
                >
                    Delete
                </button>
            </div>
            <details className={styles.ExampleDetails}>
                <summary>View recognition details</summary>
                <dl>
                    <div>
                        <dt>Your confirmation</dt>
                        <dd>{example.quantity}</dd>
                    </div>
                    <div>
                        <dt>Accepted OCR quantity</dt>
                        <dd>{example.originalQuantity ?? "None — unresolved"}</dd>
                    </div>
                    <div>
                        <dt>Purpose</dt>
                        <dd>
                            {example.validation ? "Checks recognition accuracy" : "Helps recognize similar quantities"}
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
                            Initial OCR evidence, before any manual retry. Readings are guesses; your confirmed quantity
                            is the label used for self-improvement.
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
                <p>Help the app recognize loot quantities by confirming captures in Needs attention.</p>
                {!learning.available ? (
                    <p>Self-improvement is available in the desktop app.</p>
                ) : (
                    <>
                        <label className={styles.Option}>
                            <span>
                                <strong>Learn from my corrections</strong>
                                <small>
                                    Save the quantity image and number when you confirm a normal drop in Needs
                                    attention.
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
                                    Automatically add unresolved quantities when saved examples pass the recognition
                                    checks. Otherwise, ask you to confirm.
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
                                        ? "Some saved quantities have passed validation. Each new drop must still have a clear item and matching readings across frames."
                                        : "Waiting for more confirmed examples to pass validation. Matches will stay as suggestions for now."
                                    : "Saved examples can suggest a number in Needs attention. You check the capture and choose Add to session."}
                            </p>
                        </div>
                        <p>
                            Images and corrections stay on this device. This version learns whole quantities for your
                            font, UI scale, and resolution.
                        </p>
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
                                            Check what the app has learned, or delete an example with an incorrect
                                            number. Some examples are kept aside to check recognition accuracy.
                                        </p>
                                        {examplesOpen && (
                                            <ul className={styles.Examples} aria-label="Saved quantity examples">
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
