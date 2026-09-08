import { useEffect, useRef, useState } from "react";
import { LiveLootCapture } from "../../components/LiveLootCapture/LiveLootCapture";
import { useLiveLootCapture } from "../../components/LiveLootCapture/useLiveLootCapture";
import { LootLedger } from "../../components/LootLedger/LootLedger";
import { grindSpots } from "../../data/grindSpots";
import { createEntry, type SessionState } from "../../domain/session";
import { formatTimestamp } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import type { LootFont } from "../../recognition/lootFont";
import styles from "./LiveSession.module.css";
import { SessionMetrics } from "./SessionSummary";
import { SessionTools } from "./SessionTools";

export function LiveSessionView({
    controller,
    lootFont,
    lootFontReady,
    overlay,
    visible,
    onCaptureStatusChange,
    captureSetupRequest,
    onOpenHistory,
}: {
    overlay: { openOverlay: () => Promise<void>; error: string; available: boolean };
    onOpenHistory: () => void;
    controller: LiveSessionController;
    lootFont: LootFont;
    lootFontReady: boolean;
    visible: boolean;
    captureSetupRequest: number;
    onCaptureStatusChange: (status: string) => void;
}) {
    const {
        session,
        dispatch,
        databaseLoaded,
        editingDisabled,
        spot,
        drops,
        marketItemIds,
        changeRegion,
        changeGrindSpot,
        market,
    } = controller;
    const spotEditable = session.status === "idle" && session.elapsedMs === 0 && session.entries.length === 0;
    function acceptCapturedLoot(itemName: string, quantity: number, source: "manual" | "recognition" = "recognition") {
        if (!databaseLoaded) return "The local database is still loading.";
        if (session.status === "finished") return "Finished sessions cannot accept more loot.";
        if (!Number.isSafeInteger(quantity) || quantity <= 0) return "Enter a positive whole-number quantity.";
        const drop = drops.find((candidate) => candidate.name === itemName);
        if (!drop) return "The item is not in the active grind-spot profile.";
        const marketPrice = market.currentMarketPrices.find((price) => price.itemId === drop.marketItemId)?.basePrice;
        const unitPrice = marketPrice ?? drop.unitPrice;
        if (unitPrice === null || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
            return "No valid price is available. Fetch market prices or add this item manually.";
        }
        const combinedQuantity = session.entries.reduce(
            (total, entry) =>
                entry.name === drop.name && entry.valuation === drop.valuation && entry.unitPrice === unitPrice
                    ? total + entry.quantity
                    : total,
            quantity,
        );
        if (!Number.isSafeInteger(combinedQuantity)) return "The combined item quantity is too large.";
        dispatch({
            type: "add-entry",
            entry: {
                ...createEntry(drop.name, quantity, unitPrice, drop.valuation),
                source,
            },
        });
        return null;
    }

    const capture = useLiveLootCapture({
        lootFont,
        lootFontReady,
        visible,
        setupRequest: captureSetupRequest,
        onStatusChange: onCaptureStatusChange,
        databaseLoaded,
        sessionId: session.id,
        sessionStatus: session.status,
        grindSpotId: session.grindSpotId,
        grindSpotName: spot.name,
        itemDictionary: drops.map((drop) => drop.name),
        onAcceptRecognition: acceptCapturedLoot,
    });
    const finishDialog = useRef<HTMLDialogElement>(null);
    const finishRequest = useRef(0);
    const [preparingReview, setPreparingReview] = useState(false);
    const [finishError, setFinishError] = useState("");
    const unresolvedCount = capture.reviewResults.filter((entry) => !entry.accepted).length;
    useEffect(() => {
        finishDialog.current?.close();
        setPreparingReview(false);
        setFinishError("");
        return () => {
            finishRequest.current += 1;
        };
    }, [session.id]);

    async function requestFinish() {
        if (preparingReview || !databaseLoaded || session.status === "finished") return;
        const request = ++finishRequest.current;
        if (session.status === "running") dispatch({ type: "pause", now: Date.now() });
        setPreparingReview(true);
        setFinishError("");
        finishDialog.current?.showModal();
        document.getElementById("finish-review-title")?.focus();
        try {
            const remaining = await capture.prepareReview();
            if (request !== finishRequest.current) return;
            if (remaining === null) {
                setFinishError("Capture changed while preparing review. Keep the session open and try again.");
            } else if (remaining === 0) {
                finishDialog.current?.close();
                dispatch({ type: "finish", now: Date.now() });
            }
        } catch (error) {
            if (request === finishRequest.current) setFinishError(`Could not finish reading drops: ${String(error)}`);
        } finally {
            if (request === finishRequest.current) setPreparingReview(false);
        }
    }

    function keepSessionOpen() {
        finishRequest.current += 1;
        if (preparingReview) capture.stopCapture();
        setPreparingReview(false);
        finishDialog.current?.close();
    }

    return (
        <>
            <header className="topbar">
                <div>
                    <h1>{spotEditable ? "New session" : spot.name}</h1>
                </div>
                <button
                    type="button"
                    className="button"
                    disabled={!databaseLoaded || !overlay.available}
                    title={
                        overlay.available
                            ? "Open a draggable, always-on-top session window"
                            : "Available in the desktop app"
                    }
                    onClick={overlay.openOverlay}
                >
                    Pop out session
                </button>
            </header>
            {overlay.error && <p role="alert">{overlay.error}</p>}
            <section className={styles.SetupBar} aria-label="Session setup">
                <div className={styles.SessionMeta}>
                    <label>
                        <span className="sr-only">Grind spot</span>
                        <select
                            aria-describedby="spot-lock-note"
                            title={spotEditable ? "Grind spot" : "Grind spot locked after recording time or loot"}
                            value={session.grindSpotId}
                            disabled={!databaseLoaded || !spotEditable || market.fetchingPrices}
                            onChange={(event) => changeGrindSpot(event.target.value)}
                        >
                            {grindSpots.map((grindSpot) => (
                                <option key={grindSpot.id} value={grindSpot.id}>
                                    {grindSpot.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        <span className="sr-only">Region</span>
                        <select
                            value={session.region}
                            disabled={editingDisabled || market.fetchingPrices}
                            onChange={(event) => changeRegion(event.target.value as SessionState["region"])}
                        >
                            <option value="eu">EU</option>
                            <option value="na">NA</option>
                        </select>
                    </label>
                </div>
                <p id="spot-lock-note" className="sr-only">
                    {spotEditable
                        ? "Choose your spot before recording time or loot."
                        : "Grind spot locked for this session."}
                </p>
                <details className={styles.MarketSnapshot}>
                    <summary>
                        <span>Market prices</span>
                        <strong>
                            {market.marketPrices === null
                                ? "Loading…"
                                : market.currentMarketPrices.length === 0
                                  ? "No saved prices"
                                  : market.usingFallbackPrices
                                    ? `${market.marketPriceRegion?.toUpperCase()} fallback`
                                    : `${session.region.toUpperCase()} snapshot saved`}
                        </strong>
                    </summary>
                    <div className={styles.MarketDetails} aria-live="polite">
                        <div>
                            <p className="eyebrow">Prices from Arsha</p>
                            {market.marketPrices === null ? (
                                <strong>Reading saved {session.region.toUpperCase()} prices...</strong>
                            ) : market.currentMarketPrices.length === 0 ? (
                                <>
                                    <strong>No {session.region.toUpperCase()} prices saved</strong>
                                    <span>Fetch once from Arsha, or continue with manual unit prices.</span>
                                </>
                            ) : market.usingFallbackPrices ? (
                                <>
                                    <strong>
                                        Using {market.marketPriceRegion?.toUpperCase()} prices from{" "}
                                        {formatTimestamp(market.lastPriceFetch)}
                                    </strong>
                                    <span>
                                        No {session.region.toUpperCase()} snapshot is saved.{" "}
                                        {market.currentMarketPrices.length} of {marketItemIds.length}{" "}
                                        {market.marketPriceRegion?.toUpperCase()} profile items are used as fallback.
                                    </span>
                                </>
                            ) : (
                                <>
                                    <strong>
                                        {session.region.toUpperCase()} prices from{" "}
                                        {formatTimestamp(market.lastPriceFetch)}
                                    </strong>
                                    <span>
                                        {market.currentMarketPrices.length} of {marketItemIds.length} profile items
                                        saved locally.
                                    </span>
                                </>
                            )}
                            {market.marketError && <span className={styles.MarketError}>{market.marketError}</span>}
                        </div>
                        <button
                            className="button"
                            type="button"
                            disabled={!databaseLoaded || market.fetchingPrices || market.marketPrices === null}
                            onClick={market.fetchMarketPrices}
                        >
                            {market.fetchingPrices
                                ? "Fetching..."
                                : market.marketPriceRegion !== session.region
                                  ? `Fetch ${session.region.toUpperCase()} prices`
                                  : "Refresh prices"}
                        </button>
                    </div>
                </details>
            </section>
            <SessionMetrics controller={controller} visible={visible} onFinish={() => void requestFinish()} />
            <dialog
                ref={finishDialog}
                className={styles.FinishDialog}
                aria-labelledby="finish-review-title"
                onCancel={keepSessionOpen}
            >
                <h2 id="finish-review-title" tabIndex={-1}>
                    {preparingReview ? "Reading final drops…" : "Review before finishing"}
                </h2>
                <p role="status">
                    {preparingReview
                        ? "The timer is paused while the remaining captures are read."
                        : finishError
                          ? "Review preparation did not complete. Your session is still open."
                          : unresolvedCount > 0
                            ? `${unresolvedCount} ${unresolvedCount === 1 ? "entry still needs" : "entries still need"} attention. These drops have not been added to your session.`
                            : "All captured drops have been reviewed."}
                </p>
                {!preparingReview && unresolvedCount > 0 && (
                    <p>Review or dismiss them now. Finishing without adding them discards their saved captures.</p>
                )}
                {finishError && <p role="alert">{finishError}</p>}
                <div className={styles.FinishActions}>
                    {!preparingReview && unresolvedCount > 0 && (
                        <button
                            type="button"
                            className="button primary-button"
                            onClick={() => {
                                keepSessionOpen();
                                const heading = document.getElementById("loot-review-heading");
                                heading?.scrollIntoView({ block: "start" });
                                heading?.focus({ preventScroll: true });
                            }}
                        >
                            Review drops
                        </button>
                    )}
                    <button type="button" className="button" onClick={keepSessionOpen}>
                        Keep session open
                    </button>
                    {!preparingReview && !finishError && (
                        <button
                            type="button"
                            className="button subtle"
                            disabled={!databaseLoaded}
                            onClick={() => {
                                finishDialog.current?.close();
                                dispatch({ type: "finish", now: Date.now() });
                            }}
                        >
                            {unresolvedCount > 0 ? "Finish without adding these drops" : "Finish session"}
                        </button>
                    )}
                </div>
            </dialog>
            {session.status === "finished" && (
                <section className={styles.Completion} aria-label="Session complete">
                    <div>
                        <strong>Session complete</strong>
                        <span>Review this session in History, or start a new one when you are ready.</span>
                    </div>
                    <button className="button" type="button" onClick={onOpenHistory}>
                        View history
                    </button>
                </section>
            )}
            <div className={styles.DeskBody}>
                <LiveLootCapture controller={capture} />
                <div className={styles.ContentGrid}>
                    <LootLedger
                        key={session.id}
                        tools={<SessionTools controller={controller} visible={visible} />}
                        entries={session.entries}
                        grindSpotId={session.grindSpotId}
                        editingDisabled={editingDisabled}
                        onRemove={(id) => dispatch({ type: "remove-entry", id })}
                        onUpdate={(id, quantity, unitPrice) =>
                            dispatch({ type: "update-entry", id, quantity, unitPrice })
                        }
                    />
                </div>
            </div>
        </>
    );
}
