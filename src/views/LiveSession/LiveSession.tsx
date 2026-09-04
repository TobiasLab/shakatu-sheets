import { EntryForm } from "../../components/EntryForm/EntryForm";
import { LiveLootCapture } from "../../components/LiveLootCapture/LiveLootCapture";
import { LootLedger } from "../../components/LootLedger/LootLedger";
import { MarniImport } from "../../components/MarniImport/MarniImport";
import { grindSpots } from "../../data/grindSpots";
import { createEntry, type SessionState } from "../../domain/session";
import { formatTimestamp } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";
import { SessionClock, SessionMetrics } from "./SessionSummary";

export function LiveSessionView({
    controller,
    visible,
    onCaptureStatusChange,
    captureSetupRequest,
}: {
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
    const timerStatusLabel =
        session.status === "idle"
            ? "Timer not started"
            : session.status === "running"
              ? "Timer running"
              : session.status === "paused"
                ? "Timer paused"
                : "Session finished";

    function acceptRecognizedLoot(itemName: string, quantity: number) {
        if (!databaseLoaded) return "The local database is still loading.";
        if (session.status === "finished") return "Finished sessions cannot accept more loot.";
        if (!Number.isSafeInteger(quantity) || quantity <= 0) return "The recognized quantity is invalid.";
        const drop = drops.find((candidate) => candidate.name === itemName);
        if (!drop) return "The recognized item is not in the active grind-spot profile.";
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
        if (!Number.isSafeInteger(combinedQuantity)) return "The combined recognized quantity is too large.";
        dispatch({
            type: "add-entry",
            entry: {
                ...createEntry(drop.name, quantity, unitPrice, drop.valuation),
                source: "recognition",
            },
        });
        return null;
    }

    return (
        <>
            <header className="topbar">
                <div>
                    <p className="eyebrow">Your grind, at a glance</p>
                    <h1>{spot.name}</h1>
                </div>
                <div className={styles.SessionMeta}>
                    <label>
                        Grind spot
                        <select
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
                        Region
                        <select
                            value={session.region}
                            disabled={editingDisabled || market.fetchingPrices}
                            onChange={(event) => changeRegion(event.target.value as SessionState["region"])}
                        >
                            <option value="eu">EU</option>
                            <option value="na">NA</option>
                        </select>
                    </label>
                    <span className={`${styles.SessionState} ${styles[session.status]}`}>{timerStatusLabel}</span>
                </div>
            </header>

            <SessionClock controller={controller} visible={visible} />
            <SessionMetrics controller={controller} visible={visible} />

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
                onAcceptRecognition={acceptRecognizedLoot}
            />

            <section className={styles.MarketSnapshot} aria-live="polite">
                <div>
                    <p className="eyebrow">Manual market snapshot</p>
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
                                No {session.region.toUpperCase()} snapshot is saved. {market.currentMarketPrices.length}{" "}
                                of {marketItemIds.length} {market.marketPriceRegion?.toUpperCase()} profile items are
                                used as fallback.
                            </span>
                        </>
                    ) : (
                        <>
                            <strong>
                                {session.region.toUpperCase()} prices from {formatTimestamp(market.lastPriceFetch)}
                            </strong>
                            <span>
                                {market.currentMarketPrices.length} of {marketItemIds.length} profile items saved
                                locally.
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
            </section>

            <div className={styles.ContentGrid}>
                <div className={styles.EntryTools}>
                    <details className={styles.ToolPanel}>
                        <summary>
                            Add loot or expense <span>Manual entry</span>
                        </summary>
                        <EntryForm {...controller} />
                    </details>
                    <details className={styles.ToolPanel}>
                        <summary>
                            Import a screenshot <span>Marni tracker</span>
                        </summary>
                        <MarniImport controller={controller} />
                    </details>
                </div>
                <LootLedger
                    entries={session.entries}
                    grindSpotId={session.grindSpotId}
                    editingDisabled={editingDisabled}
                    onRemove={(id) => dispatch({ type: "remove-entry", id })}
                    onUpdate={(id, quantity, unitPrice) => dispatch({ type: "update-entry", id, quantity, unitPrice })}
                />
            </div>
        </>
    );
}
