import type { Dispatch, ReactNode, SetStateAction } from "react";
import styles from "./HistoryAnalytics.module.css";

export type CollapsibleSection = "items" | "market-prices" | "rare-drops" | "rare-drop-log";
export type ClosedSections = ReadonlySet<CollapsibleSection>;

// An analytics section whose table folds away under its heading. History keeps which sections are closed, so they stay
// closed across reloads and filter changes while History is open.
export function Collapsible({
    section,
    title,
    closed,
    onClosedChange,
    children,
}: {
    section: CollapsibleSection;
    title: string;
    closed: ClosedSections;
    onClosedChange: Dispatch<SetStateAction<ClosedSections>>;
    children: ReactNode;
}) {
    return (
        <details
            className={`${styles.Items} ${styles.Collapsible}`}
            aria-label={title}
            open={!closed.has(section)}
            onToggle={(event) => {
                const open = event.currentTarget.open;
                onClosedChange((current) => {
                    if (open === !current.has(section)) return current;
                    const next = new Set(current);
                    if (open) next.delete(section);
                    else next.add(section);
                    return next;
                });
            }}
        >
            <summary>
                <h2>{title}</h2>
            </summary>
            {children}
        </details>
    );
}
