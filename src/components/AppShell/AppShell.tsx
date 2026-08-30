import type { ReactNode } from "react";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import type { Theme } from "../../hooks/useTheme";
import styles from "./AppShell.module.css";

export type AppView = "live" | "history" | "settings";

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
            <button
                className={view === "settings" ? styles.Active : ""}
                type="button"
                onClick={() => onChange("settings")}
            >
                Settings
            </button>
        </nav>
    );
}

function ThemeSelector({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
    return (
        <label className={styles.ThemeSelector}>
            Theme
            <select value={theme} onChange={(event) => onChange(event.target.value as Theme)}>
                <option value="light">Light</option>
                <option value="moss">Moss green</option>
                <option value="dark">Dark</option>
            </select>
        </label>
    );
}

export function AppShell({
    view,
    onViewChange,
    theme,
    onThemeChange,
    databaseStatus,
    databaseError,
    children,
}: {
    view: AppView;
    onViewChange: (view: AppView) => void;
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
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
                <div className={styles.DesktopTheme}>
                    <ThemeSelector theme={theme} onChange={onThemeChange} />
                </div>
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
                    <ThemeSelector theme={theme} onChange={onThemeChange} />
                </div>
                {children}
            </main>
        </div>
    );
}
