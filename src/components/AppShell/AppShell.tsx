import type { ReactNode } from "react";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import styles from "./AppShell.module.css";

export type AppView = "live" | "history";

function ViewNavigation({ view, onChange }: { view: AppView; onChange: (view: AppView) => void }) {
    return (
        <nav className={styles.ViewNavigation} aria-label="Application views">
            <button className={view === "live" ? styles.Active : ""} type="button" onClick={() => onChange("live")}>
                Live session
            </button>
            <button
                className={view === "history" ? styles.Active : ""}
                type="button"
                onClick={() => onChange("history")}
            >
                History
            </button>
        </nav>
    );
}

export function AppShell({
    view,
    onViewChange,
    databaseStatus,
    databaseError,
    children,
}: {
    view: AppView;
    onViewChange: (view: AppView) => void;
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
                <div className={`${styles.DatabaseState} ${styles[databaseStatus]}`}>
                    <div className={styles.StatusHeading}>
                        <span className={styles.StatusDot} /> Local database
                    </div>
                    <strong>{databaseStatus}</strong>
                    <small>{databaseError || "Session data stored on this device"}</small>
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
