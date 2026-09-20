import type { ReactNode } from "react";
import type { SessionStatus } from "../../domain/session";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import { Icon } from "../Icon/Icon";
import styles from "./AppShell.module.css";

export type AppView = "live" | "history" | "settings";

export function AppShell({
    view,
    onViewChange,
    onOpenCapture,
    sessionStatus,
    spotName,
    captureStatus,
    databaseStatus,
    databaseError,
    children,
}: {
    view: AppView;
    onViewChange: (view: AppView) => void;
    onOpenCapture: () => void;
    sessionStatus: SessionStatus;
    spotName: string;
    captureStatus: string;
    databaseStatus: DatabaseStatus;
    databaseError: string;
    children: ReactNode;
}) {
    return (
        <div className={styles.AppShell}>
            <a className={styles.SkipLink} href="#workspace">
                Skip to workspace
            </a>
            <header className={styles.AppBar}>
                <div className={styles.Brand}>
                    <Icon name="brand" size={26} />
                    <span>
                        Shakatu <span>Sheets</span>
                    </span>
                </div>
                <nav className={styles.Navigation} aria-label="Application views">
                    <button
                        type="button"
                        aria-label="Grind desk"
                        aria-current={view === "live" ? "page" : undefined}
                        onClick={() => onViewChange("live")}
                    >
                        <span>Grind desk</span>
                    </button>
                    <button
                        type="button"
                        aria-label="History"
                        aria-current={view === "history" ? "page" : undefined}
                        onClick={() => onViewChange("history")}
                    >
                        <span>History</span>
                    </button>
                    <button type="button" aria-label="Capture setup" onClick={onOpenCapture}>
                        <span>Capture setup</span>
                    </button>
                    <button
                        type="button"
                        aria-label="Settings"
                        aria-current={view === "settings" ? "page" : undefined}
                        onClick={() => onViewChange("settings")}
                    >
                        <span>Settings</span>
                    </button>
                </nav>
                <div className={styles.SessionPresence}>
                    {sessionStatus !== "idle" && (
                        <button
                            type="button"
                            aria-label={`Current session: ${spotName}`}
                            title={spotName}
                            onClick={() => onViewChange("live")}
                        >
                            <i className={styles.StatusDot} data-status={sessionStatus} />
                            <span>
                                {sessionStatus === "running"
                                    ? "Session running"
                                    : sessionStatus === "paused"
                                      ? "Session paused"
                                      : "Session complete"}
                            </span>
                        </button>
                    )}
                    <span role="status">
                        {databaseStatus === "saving"
                            ? "Saving…"
                            : databaseStatus === "loading"
                              ? "Loading session…"
                              : databaseStatus === "error"
                                ? "Could not save"
                                : sessionStatus !== "idle"
                                  ? captureStatus
                                  : ""}
                    </span>
                </div>
            </header>
            {databaseError && (
                <div className={styles.SaveError} role="alert">
                    <strong>Could not save your session.</strong> {databaseError}
                </div>
            )}
            <main id="workspace" tabIndex={-1} className={styles.Workspace}>
                {children}
            </main>
        </div>
    );
}
