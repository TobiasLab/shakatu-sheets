import { getCurrentWindow } from "@tauri-apps/api/window";
import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { supportsTauriApi } from "../../api/tauri";
import { calculateTotals, type SessionState } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import type { DatabaseStatus } from "../../hooks/usePersistedSession";
import { Icon } from "../Icon/Icon";
import type { CaptureSummary } from "../LiveLootCapture/useLiveLootCapture";
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
    onOpenReview,
    databaseStatus,
    databaseError,
    children,
}: {
    view: AppView;
    onViewChange: (view: AppView) => void;
    session: SessionState;
    spotName: string;
    captureStatus: CaptureSummary;
    onOpenReview: () => void;
    databaseStatus: DatabaseStatus;
    databaseError: string;
    children: ReactNode;
}) {
    const workspace = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        workspace.current?.scrollTo(0, 0);
    }, [view]);
    return (
        <div className={styles.AppShell}>
            <a className={styles.SkipLink} href="#workspace">
                Skip to workspace
            </a>
            <header className={styles.Bar} data-tauri-drag-region="deep">
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
                    {captureStatus.pendingReviews > 0 && (
                        <button
                            type="button"
                            className={styles.Review}
                            aria-label={`${captureStatus.pendingReviews} ${captureStatus.pendingReviews === 1 ? "drop needs" : "drops need"} attention`}
                            onClick={onOpenReview}
                        >
                            <span>{captureStatus.pendingReviews}</span>
                            <small>
                                {captureStatus.pendingReviews === 1 ? "drop needs attention" : "drops need attention"}
                            </small>
                        </button>
                    )}
                    <span className={styles.Capture}>
                        <i className={styles.StatusDot} data-tone={captureStatus.tone} />
                        {captureStatus.label}
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
                {supportsTauriApi() && <WindowControls />}
            </header>
            {databaseError && (
                <div className={styles.SaveError} role="alert">
                    <strong>Session storage needs attention.</strong> {databaseError}
                </div>
            )}
            <main id="workspace" ref={workspace} tabIndex={-1} className={styles.Workspace}>
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
    const { netPerHour } = calculateTotals(session.entries, elapsedMs);
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
            {elapsedMs > 0 && <strong>{formatSilver(netPerHour, true)}/h</strong>}
        </button>
    );
}

// Native caption buttons do not take focus, so a click leaves focus where the user was typing.
function keepFocus(event: MouseEvent) {
    event.preventDefault();
}

function WindowControls() {
    const [maximized, setMaximized] = useState(false);
    useEffect(() => {
        const appWindow = getCurrentWindow();
        let disposed = false;
        let revision = 0;
        let unlisten: (() => void) | undefined;
        const refresh = async () => {
            const request = ++revision;
            const next = await appWindow.isMaximized();
            if (!disposed && request === revision) setMaximized(next);
        };
        void appWindow
            .onResized(() => {
                void refresh().catch(() => undefined);
            })
            .then((stop) => {
                if (disposed) void Promise.resolve(stop()).catch(() => undefined);
                else unlisten = stop;
            })
            .catch(() => undefined);
        void refresh().catch(() => undefined);
        return () => {
            disposed = true;
            if (unlisten) void Promise.resolve(unlisten()).catch(() => undefined);
        };
    }, []);
    const maximizeLabel = maximized ? "Restore window" : "Maximize window";
    return (
        <>
            {/* On Linux the top edge resizes the undecorated window; dragging there would turn the resize into a move. */}
            {!maximized && <div className={styles.ResizeEdge} data-tauri-drag-region="false" />}
            <div className={styles.WindowControls}>
                <button
                    type="button"
                    aria-label="Minimize window"
                    title="Minimize window"
                    onMouseDown={keepFocus}
                    onClick={() => void getCurrentWindow().minimize()}
                >
                    <Icon name="minimize" size={16} />
                </button>
                <button
                    type="button"
                    aria-label={maximizeLabel}
                    title={maximizeLabel}
                    onMouseDown={keepFocus}
                    onClick={() => void getCurrentWindow().toggleMaximize()}
                >
                    <Icon name={maximized ? "restore" : "maximize"} size={16} />
                </button>
                <button
                    type="button"
                    className={styles.Close}
                    aria-label="Close window"
                    title="Close window"
                    onMouseDown={keepFocus}
                    onClick={() => void getCurrentWindow().close()}
                >
                    <Icon name="close" size={16} />
                </button>
            </div>
        </>
    );
}
