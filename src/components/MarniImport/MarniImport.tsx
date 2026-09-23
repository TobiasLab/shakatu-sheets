import { useRef, useState } from "react";
import { getGrindSpotDrops, grindSpots } from "../../data/grindSpots";
import { createEntry } from "../../domain/session";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import { type MarniRecognition, recognizeMarniScreenshot } from "../../recognition/marni";
import { Feedback } from "../Feedback/Feedback";
import { FormField } from "../FormField/FormField";
import styles from "./MarniImport.module.css";

function formatDurationInput(elapsedMs: number | null): string {
    if (elapsedMs === null) return "";
    const seconds = Math.round(elapsedMs / 1_000);
    return [Math.floor(seconds / 3_600), Math.floor((seconds % 3_600) / 60), seconds % 60]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}

function parseDurationInput(value: string): number | null {
    const match = value.match(/^(\d+):([0-5]\d):([0-5]\d)$/);
    if (!match) return null;
    const elapsedMs = (Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3])) * 1_000;
    return Number.isSafeInteger(elapsedMs) && elapsedMs > 0 ? elapsedMs : null;
}

export function MarniImport({ controller }: { controller: LiveSessionController }) {
    const { session, dispatch, databaseLoaded, market } = controller;
    const input = useRef<HTMLInputElement>(null);
    const [draft, setDraft] = useState<MarniRecognition | null>(null);
    const [duration, setDuration] = useState("");
    const [status, setStatus] = useState("");
    const [progress, setProgress] = useState(0);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const processing = status !== "";
    const canImport =
        databaseLoaded && session.status === "idle" && session.elapsedMs === 0 && session.entries.length === 0;
    const drops = getGrindSpotDrops(draft?.grindSpotId ?? session.grindSpotId);
    const elapsedMs = parseDurationInput(duration);
    const selectedItems =
        draft?.items.filter(
            (item) =>
                item.suggestedDropName !== "" &&
                Number.isSafeInteger(Number(item.quantity)) &&
                Number(item.quantity) > 0,
        ) ?? [];

    async function chooseScreenshot(file: File | undefined) {
        if (!file || !canImport) return;
        setDraft(null);
        setMessage("");
        setError("");
        setProgress(0);
        try {
            const result = await recognizeMarniScreenshot(file, session.grindSpotId, (message, value) => {
                setStatus(message);
                setProgress(value);
            });
            setDraft(result);
            setDuration(formatDurationInput(result.elapsedMs));
        } catch (recognitionError) {
            setError(String(recognitionError));
        } finally {
            setStatus("");
            setProgress(0);
            if (input.current) input.current.value = "";
        }
    }

    function updateItem(slot: number, field: "suggestedDropName" | "quantity", value: string) {
        setDraft((current) =>
            current
                ? {
                      ...current,
                      items: current.items.map((item) =>
                          item.slot === slot
                              ? {
                                    ...item,
                                    [field]: value,
                                    ...(field === "quantity" ? { quantityConfidence: 100 } : { matchScore: 0 }),
                                }
                              : item,
                      ),
                  }
                : current,
        );
    }

    function changeGrindSpot(grindSpotId: string) {
        setDraft((current) =>
            current
                ? {
                      ...current,
                      grindSpotId,
                      items: current.items.map((item) => ({ ...item, suggestedDropName: "", matchScore: null })),
                  }
                : current,
        );
    }

    function applyImport() {
        if (!draft || elapsedMs === null || selectedItems.length === 0 || !canImport) return;
        const entries = selectedItems.map((item) => {
            const drop = drops.find((candidate) => candidate.name === item.suggestedDropName);
            if (!drop) throw new Error(`Unknown recognized item: ${item.suggestedDropName}`);
            const marketPrice = market.currentMarketPrices.find(
                (price) => price.itemId === drop.marketItemId,
            )?.basePrice;
            const unitPrice = marketPrice ?? drop.unitPrice ?? 0;
            return {
                ...createEntry(drop.name, Number(item.quantity), unitPrice, drop.valuation),
                source: "recognition" as const,
            };
        });
        dispatch({ type: "import-recognition", grindSpotId: draft.grindSpotId, elapsedMs, entries });
        setMessage(`Imported ${entries.length} ${entries.length === 1 ? "entry" : "entries"} into the session.`);
        setDraft(null);
        setDuration("");
        setError("");
    }

    return (
        <section className={styles.ImportPanel} aria-labelledby="marni-import-heading">
            <div className={styles.ImportIntro}>
                <div>
                    <h2 id="marni-import-heading">Import Marni loot</h2>
                    <span>Use a cropped loot tracker screenshot at 80%, 100%, or 120% UI scale.</span>
                </div>
                <label className={`button ${styles.FileButton}`}>
                    {processing ? "Reading screenshot..." : "Choose screenshot"}
                    <input
                        ref={input}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={!canImport || processing}
                        onChange={(event) => chooseScreenshot(event.target.files?.[0])}
                    />
                </label>
            </div>
            {!canImport && !draft && !message && (
                <p className={styles.Note}>Start with an empty session to import a screenshot.</p>
            )}
            {processing && (
                <div className={styles.Progress} aria-live="polite">
                    <progress aria-label="Screenshot recognition" max="1" value={progress} />
                    <span>{status}</span>
                </div>
            )}
            {error && <Feedback tone="error">{error}</Feedback>}
            {message && <Feedback tone="success">{message}</Feedback>}
            {draft && (
                <div className={styles.Draft}>
                    <div className={styles.DraftMeta}>
                        <FormField label="Grind spot">
                            <select value={draft.grindSpotId} onChange={(event) => changeGrindSpot(event.target.value)}>
                                {grindSpots.map((spot) => (
                                    <option key={spot.id} value={spot.id}>
                                        {spot.name}
                                    </option>
                                ))}
                            </select>
                        </FormField>
                        <FormField label="Duration (HH:MM:SS)">
                            <input
                                value={duration}
                                placeholder="01:00:00"
                                inputMode="numeric"
                                aria-invalid={duration !== "" && elapsedMs === null}
                                onChange={(event) => setDuration(event.target.value)}
                            />
                        </FormField>
                    </div>
                    <p className={styles.ReviewNote}>
                        Review every row marked Check. Low-confidence suggestions stay filled in; blank or invalid rows
                        are ignored until corrected.
                    </p>
                    <div className={styles.Items}>
                        {draft.items.map((item) => {
                            const quantity = Number(item.quantity);
                            const needsReview =
                                item.suggestedDropName === "" ||
                                !Number.isSafeInteger(quantity) ||
                                quantity <= 0 ||
                                item.quantityConfidence < 70 ||
                                item.matchScore === null ||
                                item.matchScore > 0.25;
                            return (
                                <div className={styles.Item} key={item.slot} data-needs-review={needsReview}>
                                    <img src={item.thumbnail} alt={`Screenshot loot slot ${item.slot + 1}`} />
                                    <FormField label="Item">
                                        <select
                                            value={item.suggestedDropName}
                                            onChange={(event) =>
                                                updateItem(item.slot, "suggestedDropName", event.target.value)
                                            }
                                        >
                                            <option value="">Ignore item</option>
                                            {drops.map((drop) => (
                                                <option key={drop.name} value={drop.name}>
                                                    {drop.name}
                                                </option>
                                            ))}
                                        </select>
                                    </FormField>
                                    <FormField label="Quantity">
                                        <input
                                            type="number"
                                            min="1"
                                            step="1"
                                            value={item.quantity}
                                            aria-invalid={!Number.isSafeInteger(quantity) || quantity <= 0}
                                            onChange={(event) => updateItem(item.slot, "quantity", event.target.value)}
                                        />
                                    </FormField>
                                    <span className={needsReview ? styles.Check : styles.Ready}>
                                        {needsReview ? "Check" : "Ready"}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    <div className={styles.Actions}>
                        <button className="button subtle" type="button" onClick={() => setDraft(null)}>
                            Cancel
                        </button>
                        <button
                            className="button primary-button"
                            type="button"
                            disabled={!canImport || elapsedMs === null || selectedItems.length === 0}
                            onClick={applyImport}
                        >
                            Import {selectedItems.length} items
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}
