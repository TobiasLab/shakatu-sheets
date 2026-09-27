import type { ReactNode } from "react";
import { calculateEntryTotals, type SessionState } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import { Icon } from "../Icon/Icon";
import styles from "./AppShell.module.css";

export type AppView = "live" | "history" | "settings";

const views: { view: AppView; label: string }[] = [
    { view: "live", label: "Grind desk" },
    { view: "history", label: "History" },
    { view: "settings", label: "Settings" },
];

export function AppShell({
    view,
    onViewChange,
    session,
    spotName,
    captureStatus,
    reviewCount,
    onOpenReview,
    databaseStatus,
    databaseError,
    children,
}: {
    view: AppView;
    onViewChange: (view: AppView) => void;
    session: SessionState;
    spotName: string;
    captureStatus: string;
    reviewCount: number;
    onOpenReview: () => void;
    databaseStatus: DatabaseStatus;
    databaseError: string;
    children: ReactNode;
}) {
    return (
        <div className={styles.AppShell}>
            <a className={styles.SkipLink} href="#workspace">
                Skip to workspace
            </a>
            <header className={styles.Bar}>
                <span className={styles.Brand}>
                    <Icon name="brand" size={14} />
                    Shakatu Sheets
                </span>
                <nav className={styles.Tabs} aria-label="Application views">
                    {views.map((item) => (
                        <button
                            key={item.view}
                            type="button"
                            aria-label={item.label}
                            aria-current={view === item.view ? "page" : undefined}
                            onClick={() => onViewChange(item.view)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>
                <div className={styles.Status}>
                    {reviewCount > 0 && (
                        <button
                            type="button"
                            className={styles.Review}
                            aria-label={`${reviewCount} ${reviewCount === 1 ? "drop needs" : "drops need"} attention`}
                            onClick={onOpenReview}
                        >
                            <span>{reviewCount}</span>
                            <small>{reviewCount === 1 ? "drop needs attention" : "drops need attention"}</small>
                        </button>
                    )}
                    <span className={styles.Capture}>
                        <i
                            className={styles.StatusDot}
                            data-tone={
                                captureStatus === "Tracking loot"
                                    ? "capture"
                                    : captureStatus === "Capture needs attention"
                                      ? "error"
                                      : undefined
                            }
                        />
                        {captureStatus}
                    </span>
                    {view !== "live" && session.status !== "idle" && (
                        <SessionPresence session={session} spotName={spotName} onOpen={() => onViewChange("live")} />
                    )}
                    {databaseStatus !== "ready" && (
                        <span className={styles.DatabaseState}>
                            <i className={styles.StatusDot} data-tone={databaseStatus} />
                            {databaseStatus === "saving"
                                ? "Saving…"
                                : databaseStatus === "loading"
                                  ? "Loading session…"
                                  : "Storage error"}
                        </span>
                    )}
                </div>
            </header>
            {databaseError && (
                <div className={styles.SaveError} role="alert">
                    <strong>Session storage needs attention.</strong> {databaseError}
                </div>
            )}
            <main id="workspace" tabIndex={-1} className={styles.Workspace}>
                {children}
            </main>
        </div>
    );
}

function SessionPresence({
    session,
    spotName,
    onOpen,
}: {
    session: SessionState;
    spotName: string;
    onOpen: () => void;
}) {
    const elapsedMs = useElapsedTime(session, true);
    const net = calculateEntryTotals(session.entries).net;
    const status =
        session.status === "running" ? "Timer running" : session.status === "paused" ? "Timer paused" : "Finished";
    return (
        <button
            type="button"
            className={styles.Presence}
            title={`${spotName} · ${status}`}
            aria-label={`Current session: ${spotName}, ${status}`}
            onClick={onOpen}
        >
            <i className={styles.StatusDot} data-tone={session.status} />
            <span className={styles.PresenceSpot}>{spotName}</span>
            <time>{formatDuration(elapsedMs)}</time>
            {elapsedMs > 0 && <strong>{formatSilver(net / (elapsedMs / 3_600_000), true)}/h</strong>}
        </button>
    );
}
