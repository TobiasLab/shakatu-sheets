import { EntryForm } from "../../components/EntryForm/EntryForm";
import { LootLedger } from "../../components/LootLedger/LootLedger";
import { sycraiaLower, sycraiaMarketItemIds } from "../../data/grindSpots";
import type { SessionState } from "../../domain/session";
import { formatDuration, formatSilver, formatTimestamp } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";

export function LiveSessionView({ controller }: { controller: LiveSessionController }) {
    const {
        session,
        dispatch,
        databaseLoaded,
        elapsedMs,
        totals,
        editingDisabled,
        changeRegion,
        startOrResume,
        setCompletedHours,
        market,
    } = controller;
    const timeEditable = session.status === "idle" || session.status === "paused";

    return (
        <>
            <header className="topbar">
                <div>
                    <p className="eyebrow">Live grind ledger</p>
                    <h1>{sycraiaLower.name}</h1>
                </div>
                <div className={styles.SessionMeta}>
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
                    <span className={`${styles.SessionState} ${styles[session.status]}`}>{session.status}</span>
                </div>
            </header>

            <section className={styles.MetricsGrid} aria-label="Session summary">
                <article className={`${styles.Metric} ${styles.Primary}`}>
                    <span>Net silver / hour</span>
                    <strong>{formatSilver(totals.netPerHour, true)}</strong>
                    <small>after market tax and expenses</small>
                </article>
                <article className={styles.Metric}>
                    <span>Session net</span>
                    <strong>{formatSilver(totals.net, true)}</strong>
                    <small>{formatSilver(totals.net)} silver</small>
                </article>
                <article className={styles.Metric}>
                    <span>Gross value</span>
                    <strong>{formatSilver(totals.gross, true)}</strong>
                    <small>before deductions</small>
                </article>
                <article className={styles.Metric}>
                    <span>Expenses</span>
                    <strong>{formatSilver(totals.expenses, true)}</strong>
                    <small>consumables and fees</small>
                </article>
            </section>

            <section className={styles.SessionClock}>
                {timeEditable ? (
                    <form className={styles.CompletedHours} onSubmit={setCompletedHours}>
                        <label>
                            <span>Completed hours</span>
                            <input
                                key={session.elapsedMs}
                                name="completedHours"
                                type="number"
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                required
                                disabled={!databaseLoaded}
                                defaultValue={(session.elapsedMs / 3_600_000).toFixed(2)}
                            />
                        </label>
                        <button className="button" type="submit" disabled={!databaseLoaded}>
                            Save hours
                        </button>
                    </form>
                ) : (
                    <div>
                        <span>Elapsed session</span>
                        <time>{formatDuration(elapsedMs)}</time>
                    </div>
                )}
                <div className={styles.ClockActions}>
                    {session.status !== "running" && session.status !== "finished" && (
                        <button
                            className="button primary-button"
                            type="button"
                            disabled={!databaseLoaded}
                            onClick={startOrResume}
                        >
                            {session.status === "paused" ? "Resume" : "Start session"}
                        </button>
                    )}
                    {session.status === "running" && (
                        <button
                            className="button"
                            type="button"
                            disabled={!databaseLoaded}
                            onClick={() => dispatch({ type: "pause", now: Date.now() })}
                        >
                            Pause
                        </button>
                    )}
                    {(session.status === "running" ||
                        session.status === "paused" ||
                        (session.status === "idle" && session.elapsedMs > 0)) && (
                        <button
                            className="button subtle"
                            type="button"
                            disabled={!databaseLoaded}
                            onClick={() => dispatch({ type: "finish", now: Date.now() })}
                        >
                            Finish
                        </button>
                    )}
                    {session.status === "finished" && (
                        <button
                            className="button"
                            type="button"
                            disabled={!databaseLoaded}
                            onClick={() => dispatch({ type: "reset" })}
                        >
                            New session
                        </button>
                    )}
                </div>
            </section>

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
                                of {sycraiaMarketItemIds.length} {market.marketPriceRegion?.toUpperCase()} profile items
                                are used as fallback.
                            </span>
                        </>
                    ) : (
                        <>
                            <strong>
                                {session.region.toUpperCase()} prices from {formatTimestamp(market.lastPriceFetch)}
                            </strong>
                            <span>
                                {market.currentMarketPrices.length} of {sycraiaMarketItemIds.length} profile items saved
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
                <EntryForm {...controller} />
                <LootLedger
                    entries={session.entries}
                    editingDisabled={editingDisabled}
                    onRemove={(id) => dispatch({ type: "remove-entry", id })}
                    onUpdate={(id, quantity, unitPrice) => dispatch({ type: "update-entry", id, quantity, unitPrice })}
                />
            </div>
        </>
    );
}
