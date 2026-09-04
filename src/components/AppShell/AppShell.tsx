import type { ReactNode } from "react";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import styles from "./AppShell.module.css";

export type AppView = "live" | "history" | "settings";

function ViewNavigation({ view, onChange }: { view: AppView; onChange: (view: AppView) => void }) {
    return (
        <nav className={styles.ViewNavigation} aria-label="Application views">
            <button
                className={view === "live" ? styles.Active : ""}
                type="button"
                aria-current={view === "live" ? "page" : undefined}
                onClick={() => onChange("live")}
            >
                Grind desk
            </button>
            <button
                className={view === "history" ? styles.Active : ""}
                type="button"
                aria-current={view === "history" ? "page" : undefined}
                onClick={() => onChange("history")}
            >
                History
            </button>
            <button
                className={view === "settings" ? styles.Active : ""}
                type="button"
                aria-current={view === "settings" ? "page" : undefined}
                onClick={() => onChange("settings")}
            >
                Settings
            </button>
        </nav>
    );
}

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
            <aside className={styles.Sidebar}>
                <div className={styles.Brand}>
                    <div className={styles.BrandMark}>SS</div>
                    <div>
                        <strong>Shakatu</strong>
                        <span>Sheets</span>
                    </div>
                </div>
                <ViewNavigation view={view} onChange={onViewChange} />
                <button className={styles.SessionPresence} type="button" onClick={() => onViewChange("live")}>
                    <span className="eyebrow">Your session</span>
                    <strong>
                        {sessionStatus === "running"
                            ? "On the grind"
                            : sessionStatus === "paused"
                              ? "Taking a break"
                              : sessionStatus === "finished"
                                ? "Session complete"
                                : "Ready when you are"}
                    </strong>
                    <span>{captureStatus}</span>
                </button>
                <div className={`${styles.DatabaseState} ${styles[databaseStatus]}`}>
                    <span>
                        <i className={styles.StatusDot} />
                        {databaseStatus === "ready"
                            ? "Saved on this device"
                            : databaseStatus === "saving"
                              ? "Saving…"
                              : databaseStatus === "loading"
                                ? "Loading session…"
                                : "Could not save"}
                    </span>
                    {databaseError && <small role="alert">{databaseError}</small>}
                </div>
                <div className={styles.LicenseNote}>
                    Local only <span>AGPL-3.0</span>
                </div>
            </aside>

            <main className={styles.Workspace}>
                <div className={styles.MobileNavigation}>
                    <ViewNavigation view={view} onChange={onViewChange} />
                </div>
                {children}
            </main>
        </div>
    );
}
