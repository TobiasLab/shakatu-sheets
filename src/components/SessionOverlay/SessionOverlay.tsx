import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { getDropIcon, getGrindSpot } from "../../data/grindSpots";
import { calculateTotals } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import styles from "./SessionOverlay.module.css";
import { aggregateDrops, OVERLAY_READY, OVERLAY_STATE, type OverlaySnapshot } from "./sessionOverlay";

export function SessionOverlay() {
    const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let disposed = false;
        const stop = listen<OverlaySnapshot>(OVERLAY_STATE, ({ payload }) => {
            if (!disposed) setSnapshot(payload);
        });
        void stop
            .then(() => {
                if (!disposed) return emitTo("main", OVERLAY_READY);
            })
            .catch((error) => {
                if (!disposed) setError(String(error));
            });
        return () => {
            disposed = true;
            void stop.then((unlisten) => unlisten()).catch(() => undefined);
        };
    }, []);
    const theme = snapshot?.theme;
    useEffect(() => {
        if (theme) document.documentElement.dataset.theme = theme;
    }, [theme]);
    return (
        <main className={styles.Overlay}>
            <header className={styles.Header}>
                <button
                    type="button"
                    className={styles.DragHandle}
                    title="Drag to move overlay"
                    onMouseDown={(event) => {
                        if (event.button === 0)
                            void getCurrentWindow()
                                .startDragging()
                                .catch((error) => setError(String(error)));
                    }}
                >
                    ⠿ {snapshot ? getGrindSpot(snapshot.session.grindSpotId).name : "Session overlay"}
                </button>
                <button
                    type="button"
                    className={styles.Close}
                    aria-label="Hide session overlay"
                    onClick={() => {
                        void getCurrentWindow()
                            .hide()
                            .catch((error) => setError(String(error)));
                    }}
                >
                    ×
                </button>
            </header>
            {error && <p role="alert">{error}</p>}
            {snapshot ? <OverlayContent snapshot={snapshot} /> : <p>Waiting for the current session…</p>}
        </main>
    );
}

function OverlayContent({ snapshot }: { snapshot: OverlaySnapshot }) {
    const { session } = snapshot;
    const elapsedMs = useElapsedTime(session, true);
    const totals = calculateTotals(session.entries, elapsedMs);
    const drops = aggregateDrops(session.entries);
    return (
        <>
            <div className={styles.Metrics}>
                <div>
                    <span>Net silver / hour</span>
                    <strong>{elapsedMs > 0 ? formatSilver(totals.netPerHour, true) : "—"}</strong>
                </div>
                <div className={styles.Clock}>
                    <time>{formatDuration(elapsedMs)}</time>
                    <span>{session.status}</span>
                </div>
            </div>
            <ul className={styles.Drops} aria-label="Dropped items">
                {drops.map(({ name, quantity }) => {
                    const icon = getDropIcon(session.grindSpotId, name);
                    const label = `${name}: ${formatSilver(quantity)}`;
                    return (
                        <li key={name} title={label} aria-label={label}>
                            {icon ? (
                                <img src={icon} alt="" />
                            ) : (
                                <span className={styles.Fallback} aria-hidden="true">
                                    {name.slice(0, 2)}
                                </span>
                            )}
                            <span className={styles.Quantity}>{formatSilver(quantity, quantity >= 10000)}</span>
                        </li>
                    );
                })}
            </ul>
            {drops.length === 0 && <p className={styles.Empty}>No drops yet</p>}
        </>
    );
}
