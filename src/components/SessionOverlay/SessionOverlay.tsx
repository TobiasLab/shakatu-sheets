import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useEffect, useMemo, useState } from "react";
import { getDropIcon, getGrindSpot } from "../../data/grindSpots";
import { calculateEntryTotals } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import { OverlayTimerButton } from "./OverlayTimerButton";
import styles from "./SessionOverlay.module.css";
import {
    aggregateDrops,
    OVERLAY_READY,
    OVERLAY_STATE,
    OVERLAY_VISIBILITY_CHANGED,
    type OverlaySnapshot,
} from "./sessionOverlay";

const quantityFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export function SessionOverlay() {
    const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
    const [visible, setVisible] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let disposed = false;
        let revision = 0;
        async function refreshVisibility() {
            const request = ++revision;
            const showing = await getCurrentWindow().isVisible();
            if (!disposed && request === revision) setVisible(showing);
        }
        const refresh = () => {
            void refreshVisibility().catch((error) => {
                if (!disposed) setError(String(error));
            });
        };
        const visibilityStop = listen(OVERLAY_VISIBILITY_CHANGED, refresh);
        void visibilityStop.then(refresh).catch((error) => {
            if (!disposed) setError(String(error));
        });
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
            for (const pending of [stop, visibilityStop])
                void pending.then((unlisten) => unlisten()).catch(() => undefined);
        };
    }, []);
    const theme = snapshot?.theme;
    useEffect(() => {
        if (theme) document.documentElement.dataset.theme = theme;
    }, [theme]);
    return (
        <main className={styles.Overlay} style={{ opacity: (snapshot?.opacity ?? 100) / 100 }}>
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
                            .then(() => emit(OVERLAY_VISIBILITY_CHANGED))
                            .catch((error) => setError(String(error)));
                    }}
                >
                    ×
                </button>
            </header>
            {error && <p role="alert">{error}</p>}
            {snapshot ? (
                <OverlayContent snapshot={snapshot} visible={visible} />
            ) : (
                <p>Waiting for the current session…</p>
            )}
        </main>
    );
}

function OverlayContent({ snapshot, visible }: { snapshot: OverlaySnapshot; visible: boolean }) {
    const { session } = snapshot;
    const elapsedMs = useElapsedTime(session, visible);
    const { entries, grindSpotId } = session;
    const totals = useMemo(() => calculateEntryTotals(entries), [entries]);
    const netPerHour = elapsedMs > 0 ? totals.net / (elapsedMs / 3_600_000) : 0;
    return (
        <>
            <div className={styles.Metrics}>
                <div>
                    <span>Net silver / hour</span>
                    <strong>{elapsedMs > 0 ? formatSilver(netPerHour, true) : "—"}</strong>
                </div>
                <div>
                    <span>Session net</span>
                    <strong>{formatSilver(totals.net, true)}</strong>
                </div>
                <div className={styles.Clock}>
                    <time>{formatDuration(elapsedMs)}</time>
                    <span className={styles.Status} data-status={session.status}>
                        {session.status}
                    </span>
                    <OverlayTimerButton key={session.id} session={session} enabled={snapshot.timerEnabled} />
                </div>
            </div>
            <OverlayDrops entries={entries} grindSpotId={grindSpotId} />
        </>
    );
}

const OverlayDrops = memo(function OverlayDrops({
    entries,
    grindSpotId,
}: Pick<OverlaySnapshot["session"], "entries" | "grindSpotId">) {
    const drops = aggregateDrops(entries);
    return (
        <>
            <ul className={styles.Drops} aria-label="Dropped items">
                {drops.map(({ name, quantity }) => {
                    const icon = getDropIcon(grindSpotId, name);
                    const formattedQuantity = quantityFormatter.format(quantity);
                    const label = `${name}: ${formattedQuantity}`;
                    return (
                        <li key={name} title={label} aria-label={label}>
                            {icon ? (
                                <img src={icon} alt="" />
                            ) : (
                                <span className={styles.Fallback} aria-hidden="true">
                                    {name.slice(0, 2)}
                                </span>
                            )}
                            <span className={styles.Quantity}>{formattedQuantity}</span>
                        </li>
                    );
                })}
            </ul>
            {drops.length === 0 && <p className={styles.Empty}>No drops yet</p>}
        </>
    );
});
