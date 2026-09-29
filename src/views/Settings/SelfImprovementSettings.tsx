import { useState } from "react";
import { Feedback } from "../../components/Feedback/Feedback";
import { LearningFeedback } from "../../components/LearningFeedback/LearningFeedback";
import { QuantityImage } from "../../components/QuantityImage/QuantityImage";
import { formatRelativeDay, formatTimestamp } from "../../format";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
import type { LearningEvidence, LearningProfile, QuantityExample } from "../../recognition/quantityLearning";
import styles from "./SelfImprovementSettings.module.css";
import settingsStyles from "./Settings.module.css";

function setupName(profile: LearningProfile) {
    return `${profile.font === "korean" ? "Korean" : "Strong Sword"} · ${profile.uiScalePercent}% · ${profile.sourceWidth} × ${profile.sourceHeight}`;
}

function RecoveryChecks({ evidence }: { evidence: readonly LearningEvidence[] }) {
    const groups = new Map<string, LearningEvidence[]>();
    for (const entry of evidence) {
        const key = `${entry.kind === "item" ? "Items" : "Quantities"} · ${setupName(entry.profile)}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups].map(([name, entries]) => {
        const wrong = entries[0].wrong;
        const rows = [...entries].sort((a, b) =>
            a.kind === "quantity" ? Number(a.label) - Number(b.label) : a.label.localeCompare(b.label),
        );
        return (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Allow keyboard scrolling of the overflowing table.
            <section className={styles.TableScroll} aria-label={name} tabIndex={0} key={name}>
                <table>
                    <caption>
                        {name}
                        {wrong > 0 && ` · ${wrong} wrong ${wrong === 1 ? "prediction" : "predictions"}`}
                    </caption>
                    <thead>
                        <tr>
                            <th scope="col">{entries[0].kind === "item" ? "Item" : "Quantity"}</th>
                            <th scope="col">Templates</th>
                            <th scope="col">Checks</th>
                            <th scope="col">Other labels</th>
                            <th scope="col">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((entry) => (
                            <tr key={entry.label}>
                                <th scope="row">{entry.label}</th>
                                <td>{entry.templates}</td>
                                <td>
                                    {entry.correct}/{entry.checked}
                                </td>
                                <td>{entry.alternativesCorrect}</td>
                                <td data-ready={entry.eligible}>
                                    {entry.eligible ? "Ready" : wrong > 0 ? "Blocked" : "Not ready"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        );
    });
}

function SavedExample({
    example,
    disabled,
    onDelete,
}: {
    example: QuantityExample;
    disabled: boolean;
    onDelete: () => void;
}) {
    const label = `${example.itemName ?? "Item not recorded"} × ${example.quantity}`;
    return (
        <li className={styles.Example}>
            <div className={styles.ExampleRow}>
                <div className={styles.ExampleImages}>
                    {example.itemImage && (
                        <QuantityImage image={example.itemImage} label={`Confirmed item: ${example.itemName}`} />
                    )}
                    <QuantityImage image={example} />
                </div>
                <div className={styles.ExampleLabel}>
                    <strong>{label}</strong>
                    <span>
                        {setupName(example.profile)} · {formatRelativeDay(example.confirmedAt)}
                        {!example.itemImage && " · Quantity only"}
                    </span>
                </div>
                <button
                    className={`button subtle ${styles.Delete}`}
                    type="button"
                    disabled={disabled}
                    onClick={onDelete}
                    aria-label={`Delete example of ${example.itemName ?? "unknown item"} × ${example.quantity}`}
                >
                    Delete
                </button>
            </div>
            <details className={styles.ExampleDetails}>
                <summary>Recognition details</summary>
                <dl>
                    <div>
                        <dt>Confirmed</dt>
                        <dd>{formatTimestamp(example.confirmedAt)}</dd>
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
                    {example.audit && (
                        <>
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
                        </>
                    )}
                </dl>
                {example.audit ? (
                    <>
                        <p>OCR readings from the first attempt, before any retry.</p>
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
    const { evidence, eligibleCount } = learning.model.current;
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
                <p>
                    Help the app recognize loot by confirming captures in Needs attention. Examples stay on this device.
                </p>
                {!learning.available ? (
                    <p>Self-improvement is available in the desktop app.</p>
                ) : (
                    <>
                        <div>
                            <label className={styles.Option}>
                                <span>
                                    <strong>Learn from my corrections</strong>
                                    <small>
                                        Save the item and quantity you confirm for normal loot, with their text images.
                                    </small>
                                </span>
                                <input
                                    id="self-improvement-enabled"
                                    type="checkbox"
                                    role="switch"
                                    checked={state.enabled}
                                    aria-checked={state.enabled}
                                    disabled={!ready || busy}
                                    onChange={(event) =>
                                        void learning.setSettings(event.target.checked, state.autoAllow)
                                    }
                                />
                            </label>
                            <label className={styles.Option}>
                                <span>
                                    <strong>Auto allow</strong>
                                    <small>
                                        Add unreadable drops automatically when saved examples pass the recovery checks.
                                        Otherwise, suggest them in Needs attention.
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
                        </div>
                        <LearningFeedback learning={learning} />
                        {learning.message && !learning.error && <Feedback tone="success">{learning.message}</Feedback>}
                        {!ready && !busy && (
                            <button className="button" type="button" onClick={() => void learning.reload()}>
                                Retry loading self-improvement
                            </button>
                        )}
                        <details className={styles.Library}>
                            <summary>
                                Automatic recovery checks <span>{eligibleCount} ready</span>
                            </summary>
                            <div className={styles.LibraryBody}>
                                <p>
                                    A label is ready with 2 templates, at least 3 checks all correct, 1 correct check of
                                    another label, and no wrong predictions.
                                </p>
                                {evidence.length === 0 ? (
                                    <p>No learned labels yet.</p>
                                ) : (
                                    <RecoveryChecks evidence={evidence} />
                                )}
                            </div>
                        </details>
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
                                    <p>No examples yet. Confirm a normal-loot capture in Needs attention to add one.</p>
                                ) : (
                                    examplesOpen && (
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
                                    )
                                )}
                                {shown < state.examples.length && (
                                    <button className="button" type="button" onClick={() => setShown(shown + 20)}>
                                        Show more examples
                                    </button>
                                )}
                                <p>
                                    Keeps up to 50 examples per display setup and 200 in total. Older ones are replaced.
                                </p>
                            </div>
                        </details>
                        {confirmReset ? (
                            <Feedback
                                action={
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
                                }
                            >
                                Delete all saved examples and turn self-improvement off? Sessions stay unchanged.
                            </Feedback>
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
                    </>
                )}
            </div>
        </section>
    );
}
