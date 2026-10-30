import { useState } from "react";
import styles from "./LiveLootCapture.module.css";
import type { SampleCollectionSummary } from "./useDebugSampleCollection";

/** Development-only recording status, visible in the capture card even while setup is closed. */
export function RoiSampleStrip({
    summary,
    path,
    error,
}: {
    summary: SampleCollectionSummary;
    path: string | null;
    error: string;
}) {
    const [copiedPath, setCopiedPath] = useState<string | null>(null);
    const [copyError, setCopyError] = useState("");

    async function copyPath(value: string) {
        setCopyError("");
        try {
            await navigator.clipboard.writeText(value);
            setCopiedPath(value);
        } catch {
            setCopiedPath(null);
            setCopyError(`Could not copy the path: ${value}`);
        }
    }

    return (
        <section className={styles.SampleStrip} data-tone={summary.tone} aria-label="ROI sample recording">
            <p>
                <span className={styles.SampleHeading}>
                    <span className={styles.SampleDot} aria-hidden="true" />
                    <span className={styles.SampleTag}>Dev</span>
                    <strong role="status">{summary.label}</strong>
                </span>
                {summary.detail && <span>{summary.detail}</span>}
            </p>
            {path && (
                <button
                    className={`button ${styles.SampleCopy}`}
                    type="button"
                    title={path}
                    onClick={() => void copyPath(path)}
                >
                    {copiedPath === path ? "Copied" : "Copy path"}
                </button>
            )}
            {(error || copyError) && (
                <p className={styles.SampleError} role="alert">
                    {[error, copyError].filter(Boolean).join(" ")}
                </p>
            )}
        </section>
    );
}
