import { type ReactNode, useState } from "react";
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
    const [collapsed, setCollapsed] = useState(false);
    return (
        <div className={`${styles.AppShell} ${collapsed ? styles.Collapsed : ""}`}>
            <a className={styles.SkipLink} href="#workspace">
                Skip to workspace
            </a>
            <aside className={styles.Sidebar}>
                <div className={styles.Brand}>
                    <Icon name="brand" size={20} />
                    <span>
                        <strong>Shakatu</strong>
                        <small>Sheets</small>
                    </span>
                    <button
                        className={styles.CollapseButton}
                        type="button"
                        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        aria-expanded={!collapsed}
                        onClick={() => setCollapsed(!collapsed)}
                    >
                        <Icon name="sidebar" size={17} />
                    </button>
                </div>
                <span className={styles.NavigationLabel}>Workspace</span>
                <nav className={styles.ViewNavigation} aria-label="Application views">
                    <button
                        type="button"
                        title="Grind desk"
                        aria-label="Grind desk"
                        aria-current={view === "live" ? "page" : undefined}
                        className={view === "live" ? styles.Active : ""}
                        onClick={() => onViewChange("live")}
                    >
                        <Icon name="desk" />
                        <span>Grind desk</span>
                    </button>
                    <button
                        type="button"
                        title="History"
                        aria-label="History"
                        aria-current={view === "history" ? "page" : undefined}
                        className={view === "history" ? styles.Active : ""}
                        onClick={() => onViewChange("history")}
                    >
                        <Icon name="history" />
                        <span>History</span>
                    </button>
                    <button type="button" title="Capture setup" aria-label="Capture setup" onClick={onOpenCapture}>
                        <Icon name="capture" />
                        <span>Capture setup</span>
                    </button>
                </nav>
                <div className={styles.SessionGroup}>
                    <span className={styles.GroupLabel}>Current session</span>
                    <button
                        className={styles.SessionPresence}
                        type="button"
                        title={spotName}
                        aria-label={`Current session: ${spotName}`}
                        onClick={() => onViewChange("live")}
                    >
                        <i className={`${styles.StatusDot} ${sessionStatus === "running" ? styles.Running : ""}`} />
                        <span>
                            <strong>{spotName}</strong>
                            <small>
                                {sessionStatus === "running"
                                    ? "Timer running"
                                    : sessionStatus === "paused"
                                      ? "Timer paused"
                                      : sessionStatus === "finished"
                                        ? "Finished"
                                        : "Not started"}
                            </small>
                        </span>
                    </button>
                    <span className={styles.CaptureStatus}>{captureStatus}</span>
                </div>
                <div className={styles.SidebarBottom}>
                    <button
                        type="button"
                        title="Settings"
                        aria-label="Settings"
                        aria-current={view === "settings" ? "page" : undefined}
                        className={view === "settings" ? styles.Active : ""}
                        onClick={() => onViewChange("settings")}
                    >
                        <Icon name="settings" />
                        <span>Settings</span>
                    </button>
                    {databaseStatus !== "ready" && (
                        <div className={styles.DatabaseState} title={databaseStatus}>
                            <i className={`${styles.StatusDot} ${styles[databaseStatus] ?? ""}`} />
                            <span>
                                {databaseStatus === "saving"
                                    ? "Saving…"
                                    : databaseStatus === "loading"
                                      ? "Loading session…"
                                      : "Storage error"}
                            </span>
                        </div>
                    )}
                </div>
            </aside>
            <div className={styles.Main}>
                <header className={styles.WorkspaceBar}>
                    <span className={styles.Breadcrumb}>
                        <span>Workspace</span>
                        <i aria-hidden="true">/</i>
                        {view === "live" ? "Grind desk" : view === "history" ? "History" : "Settings"}
                    </span>
                    {sessionStatus !== "idle" && (
                        <span className={styles.WorkspaceStatus}>
                            <i className={`${styles.StatusDot} ${sessionStatus === "running" ? styles.Running : ""}`} />
                            {sessionStatus === "running"
                                ? "Session running"
                                : sessionStatus === "paused"
                                  ? "Session paused"
                                  : "Session complete"}
                        </span>
                    )}
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
        </div>
    );
}
