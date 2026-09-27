import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useEffect, useMemo, useState } from "react";
import { adjustSessionOverlay, sessionOverlayUsesLayerShell } from "../../api/sessionOverlay";
import { getDropIcon, getGrindSpot } from "../../data/grindSpots";
import { calculateEntryTotals } from "../../domain/session";
import { formatDuration, formatSilver } from "../../format";
import { useElapsedTime } from "../../hooks/useElapsedTime";
import { Icon } from "../Icon/Icon";
import { OverlayTimerButton } from "./OverlayTimerButton";
import styles from "./SessionOverlay.module.css";
import {
    aggregateDrops,
    formatOverlaySilver,
    OVERLAY_READY,
    OVERLAY_STATE,
    OVERLAY_VISIBILITY_CHANGED,
    type OverlaySnapshot,
} from "./sessionOverlay";
import { useOverlayPlacement } from "./useOverlayPlacement";

const quantityFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export function SessionOverlay() {
    const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null);
    const [visible, setVisible] = useState(false);
    const [error, setError] = useState("");
    const [layerShell, setLayerShell] = useState<boolean | null>(null);
    const { active: moving, ...moveHandlers } = useOverlayPlacement("move", setError);
    const { active: resizing, ...resizeHandlers } = useOverlayPlacement("resize", setError);
    useEffect(() => {
        let disposed = false;
        void sessionOverlayUsesLayerShell()
            .then((enabled) => {
                if (!disposed) setLayerShell(enabled);
            })
            .catch((error) => {
                if (!disposed) setError(String(error));
            });
        return () => {
            disposed = true;
        };
    }, []);
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
    const spotName = snapshot ? getGrindSpot(snapshot.session.grindSpotId).name : "Session overlay";
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
                    title={`${spotName} · ${
                        layerShell
                            ? "Drag and release to move; arrow keys also move the overlay"
                            : "Drag to move overlay"
                    }`}
                    disabled={layerShell === null}
                    {...(layerShell ? moveHandlers : {})}
                    onPointerDown={(event) => {
                        if (layerShell) moveHandlers.onPointerDown(event);
                        else if (event.button === 0)
                            void getCurrentWindow()
                                .startDragging()
                                .catch((error) => setError(String(error)));
                    }}
                >
                    <span aria-hidden="true">⠿</span> {spotName}
                </button>
                {snapshot && snapshot.pendingReviews > 0 && <OverlayPending count={snapshot.pendingReviews} />}
                {snapshot && <OverlayClock snapshot={snapshot} visible={visible} />}
                {layerShell && (
                    <button
                        type="button"
                        className={styles.DisplayButton}
                        aria-label="Move overlay to next display"
                        title="Move overlay to next display"
                        onClick={() => {
                            void adjustSessionOverlay("nextMonitor").catch((error) => setError(String(error)));
                        }}
                    >
                        <Icon name="monitor" size={15} />
                    </button>
                )}
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
                    <Icon name="close" size={16} />
                </button>
            </header>
            {(moving || resizing) && (
                <p className={styles.PlacementHint} role="status">
                    Release to {moving ? "move" : "resize"} · Esc to cancel
                </p>
            )}
            {error && (
                <p className={styles.Error} role="alert">
                    {error}
                </p>
            )}
            {snapshot ? (
                <OverlayContent snapshot={snapshot} visible={visible} />
            ) : (
                <p className={styles.Empty} role="status">
                    Waiting for the current session…
                </p>
            )}
            {layerShell && (
                <button
                    type="button"
                    className={styles.ResizeHandle}
                    aria-label="Resize overlay"
                    title="Drag and release to resize; arrow keys also resize the overlay"
                    {...resizeHandlers}
                >
                    ◢
                </button>
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
            <section className={styles.Metrics} aria-label="Session earnings">
                <div>
                    <span>Silver/h</span>
                    <OverlaySilver value={elapsedMs > 0 ? netPerHour : null} label="Net silver per hour" />
                </div>
                <div>
                    <span>Net</span>
                    <OverlaySilver value={totals.net} label="Session net silver" />
                </div>
            </section>
            <OverlayDrops entries={entries} grindSpotId={grindSpotId} />
        </>
    );
}

function OverlaySilver({ value, label }: { value: number | null; label: string }) {
    const fullAmount = value === null ? "—" : formatSilver(value);
    return (
        <strong title={`${label}: ${fullAmount}`}>
            <span className="sr-only">{`${label}: ${fullAmount}`}</span>
            <span aria-hidden="true">{value === null ? "—" : formatOverlaySilver(value)}</span>
        </strong>
    );
}

function OverlayPending({ count }: { count: number }) {
    const label = `${count} ${count === 1 ? "drop needs" : "drops need"} attention`;
    return (
        <span className={styles.Pending} title={label}>
            <span className="sr-only">{label}</span>
            <span aria-hidden="true">{count}</span>
        </span>
    );
}

function OverlayClock({ snapshot, visible }: { snapshot: OverlaySnapshot; visible: boolean }) {
    const elapsedMs = useElapsedTime(snapshot.session, visible);
    return (
        <div className={styles.Clock}>
            <time title="Session time">
                <span className="sr-only">Session time: </span>
                {formatDuration(elapsedMs)}
            </time>
            <OverlayTimerButton key={snapshot.session.id} session={snapshot.session} enabled={snapshot.timerEnabled} />
        </div>
    );
}

const OverlayDrops = memo(function OverlayDrops({
    entries,
    grindSpotId,
}: Pick<OverlaySnapshot["session"], "entries" | "grindSpotId">) {
    const drops = aggregateDrops(entries);
    return (
        <>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The loot list scrolls independently and needs keyboard access. */}
            <ul className={styles.Drops} aria-label="Dropped items" tabIndex={0}>
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
