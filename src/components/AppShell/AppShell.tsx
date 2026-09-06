import type { ReactNode } from "react";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import { Icon } from "../Icon/Icon";
import styles from "./AppShell.module.css";

export type AppView = "live" | "history" | "settings";

export function AppShell({
    view,
    onViewChange,
    sessionStatus,
    captureStatus,
    databaseStatus,
    databaseError,
    children,
}: {
    view: AppView;
    onViewChange: (view: AppView) => void;
    sessionStatus: string;
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
            <header className={styles.Header}>
                <div className={styles.Brand}>
                    <span className={styles.BrandMark} aria-hidden="true">
                        S
                    </span>
                    <span>
                        Shakatu <strong>Sheets</strong>
                    </span>
                </div>
                <nav className={styles.ViewNavigation} aria-label="Application views">
                    {(
                        [
                            { id: "live", label: "Grind desk", icon: "desk" },
                            { id: "history", label: "History", icon: "history" },
                            { id: "settings", label: "Settings", icon: "settings" },
                        ] as const
                    ).map(({ id, label, icon }) => (
                        <button
                            key={id}
                            className={view === id ? styles.Active : ""}
                            type="button"
                            aria-current={view === id ? "page" : undefined}
                            onClick={() => onViewChange(id)}
                        >
                            <Icon name={icon} />
                            {label}
                        </button>
                    ))}
                </nav>
                <button className={styles.SessionPresence} type="button" onClick={() => onViewChange("live")}>
                    <i className={`${styles.StatusDot} ${sessionStatus === "running" ? styles.Running : ""}`} />
                    <span>
                        {sessionStatus === "running"
                            ? "Session running"
                            : sessionStatus === "paused"
                              ? "Session paused"
                              : sessionStatus === "finished"
                                ? "Session complete"
                                : "Ready to grind"}
                        <small>{captureStatus}</small>
                    </span>
                    <Icon name="arrow" size={16} />
                </button>
            </header>
            {databaseError && (
                <div className={styles.SaveError} role="alert">
                    <strong>Could not save your session.</strong> {databaseError}
                </div>
            )}
            <main id="workspace" tabIndex={-1} className={styles.Workspace}>
                {children}
            </main>
            <footer className={styles.Footer}>
                <span className={styles[databaseStatus]}>
                    <i className={styles.StatusDot} />
                    {databaseStatus === "ready"
                        ? "Saved on this device"
                        : databaseStatus === "saving"
                          ? "Saving…"
                          : databaseStatus === "loading"
                            ? "Loading session…"
                            : "Could not save"}
                </span>
                <span>
                    Local by default <span aria-hidden="true">·</span> Shakatu Sheets
                </span>
            </footer>
        </div>
    );
}
