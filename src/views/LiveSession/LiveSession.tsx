import { LiveLootCapture } from "../../components/LiveLootCapture/LiveLootCapture";
import { LootLedger } from "../../components/LootLedger/LootLedger";
import { grindSpots } from "../../data/grindSpots";
import { createEntry, type SessionState } from "../../domain/session";
import { formatTimestamp } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";
import { SessionMetrics } from "./SessionSummary";
import { SessionTools } from "./SessionTools";

export function LiveSessionView({
    controller,
    visible,
    onCaptureStatusChange,
    captureSetupRequest,
    onOpenHistory,
}: {
    onOpenHistory: () => void;
    controller: LiveSessionController;
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

    return (
        <>
            <header className="topbar">
                <div>
                    <h1>{spotEditable ? "New session" : spot.name}</h1>
                </div>
            </header>
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
            <SessionMetrics controller={controller} visible={visible} />
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
                <LiveLootCapture
                    visible={visible}
                    setupRequest={captureSetupRequest}
                    onStatusChange={onCaptureStatusChange}
                    databaseLoaded={databaseLoaded}
                    sessionId={session.id}
                    sessionStatus={session.status}
                    grindSpotId={session.grindSpotId}
                    grindSpotName={spot.name}
                    itemDictionary={drops.map((drop) => drop.name)}
                    onAcceptRecognition={acceptCapturedLoot}
                />
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
