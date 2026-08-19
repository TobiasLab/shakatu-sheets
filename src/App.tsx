import { invoke } from "@tauri-apps/api/core";
import { type FormEvent, useEffect, useReducer, useRef, useState } from "react";
import { type DropTemplate, sycraiaLower } from "./data/grindSpots";
import {
    calculateTotals,
    createEntry,
    createSession,
    getElapsedMs,
    pauseRestoredSession,
    reduceSession,
    type SessionState,
    type Valuation,
} from "./domain/session";
import "./App.css";

type DatabaseStatus = "loading" | "ready" | "saving" | "error";
type MarketPriceSnapshot = {
    itemId: number;
    subId: number;
    basePrice: number;
    fetchedAt: number;
};

const marketItemIds = sycraiaLower.drops
    .map((drop) => drop.marketItemId)
    .filter((itemId): itemId is number => itemId !== undefined);

function formatSilver(value: number, compact = false) {
    if (compact) {
        return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
    }
    return new Intl.NumberFormat("en").format(Math.round(value));
}

function formatDuration(milliseconds: number) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return [hours, minutes, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

export function App() {
    const [session, dispatch] = useReducer(reduceSession, undefined, () => createSession());
    const [now, setNow] = useState(Date.now());
    const [databaseLoaded, setDatabaseLoaded] = useState(false);
    const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("loading");
    const [databaseError, setDatabaseError] = useState("");
    const persistenceQueue = useRef(Promise.resolve());
    const [marketPrices, setMarketPrices] = useState<MarketPriceSnapshot[] | null>(null);
    const [marketError, setMarketError] = useState("");
    const [fetchingPrices, setFetchingPrices] = useState(false);
    const [selectedDrop, setSelectedDrop] = useState<DropTemplate>(sycraiaLower.trash);
    const [quantity, setQuantity] = useState("1");
    const [unitPrice, setUnitPrice] = useState(String(sycraiaLower.trash.unitPrice));
    const [customName, setCustomName] = useState("");
    const [valuation, setValuation] = useState<Valuation>("vendor");

    useEffect(() => {
        let cancelled = false;
        invoke<SessionState | null>("load_active_session")
            .then((storedSession) => {
                if (cancelled) return;
                const restoredSession = storedSession
                    ? pauseRestoredSession(storedSession, Date.now())
                    : createSession();
                dispatch({ type: "hydrate", session: restoredSession });
                setDatabaseLoaded(true);
                setDatabaseStatus("ready");
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                setDatabaseError(String(error));
                setDatabaseStatus("error");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!databaseLoaded) return;

        persistenceQueue.current = persistenceQueue.current
            .then(async () => {
                setDatabaseStatus("saving");
                await invoke("save_session", { session });
                setDatabaseError("");
                setDatabaseStatus("ready");
            })
            .catch((error: unknown) => {
                setDatabaseError(String(error));
                setDatabaseStatus("error");
            });
    }, [session]);

    useEffect(() => {
        if (!databaseLoaded) return;

        let cancelled = false;
        setMarketPrices(null);
        setMarketError("");
        invoke<MarketPriceSnapshot[]>("load_market_prices", { region: session.region })
            .then((snapshots) => {
                if (!cancelled) setMarketPrices(snapshots);
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                setMarketPrices([]);
                setMarketError(`Could not read saved prices: ${String(error)}`);
            });
        return () => {
            cancelled = true;
        };
    }, [databaseLoaded, session.region]);

    useEffect(() => {
        if (marketPrices === null || selectedDrop.marketItemId === undefined) return;
        const snapshot = marketPrices.find((price) => price.itemId === selectedDrop.marketItemId);
        setUnitPrice(snapshot ? String(snapshot.basePrice) : "");
    }, [marketPrices, selectedDrop]);

    useEffect(() => {
        if (session.status !== "running") return;
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [session.status]);

    const elapsedMs = getElapsedMs(session, now);
    const totals = calculateTotals(session.entries, elapsedMs);
    const editingDisabled = !databaseLoaded || session.status === "finished";
    const currentMarketPrices = (marketPrices ?? []).filter((price) => marketItemIds.includes(price.itemId));
    const lastPriceFetch = currentMarketPrices.reduce((latest, price) => Math.max(latest, price.fetchedAt), 0);

    function chooseDrop(drop: DropTemplate) {
        setSelectedDrop(drop);
        setCustomName(drop.name);
        setValuation(drop.valuation);
        const savedPrice = marketPrices?.find((price) => price.itemId === drop.marketItemId)?.basePrice;
        setUnitPrice(
            savedPrice === undefined ? (drop.unitPrice === null ? "" : String(drop.unitPrice)) : String(savedPrice),
        );
        setQuantity("1");
    }

    async function fetchMarketPrices() {
        setFetchingPrices(true);
        setMarketError("");
        try {
            const snapshots = await invoke<MarketPriceSnapshot[]>("fetch_market_prices", {
                region: session.region,
                itemIds: marketItemIds,
            });
            setMarketPrices(snapshots);
        } catch (error) {
            setMarketError(String(error));
        } finally {
            setFetchingPrices(false);
        }
    }

    function changeRegion(region: SessionState["region"]) {
        setMarketPrices(null);
        if (selectedDrop.marketItemId !== undefined) setUnitPrice("");
        dispatch({ type: "set-region", region });
    }

    function addEntry(event: FormEvent) {
        event.preventDefault();
        if (session.status === "finished") return;
        const name = customName.trim() || selectedDrop.name;
        const parsedQuantity = Number(quantity);
        const parsedPrice = Number(unitPrice);
        if (
            !name ||
            unitPrice.trim() === "" ||
            !Number.isSafeInteger(parsedQuantity) ||
            parsedQuantity <= 0 ||
            parsedPrice < 0 ||
            !Number.isSafeInteger(parsedPrice) ||
            !Number.isFinite(parsedQuantity)
        )
            return;
        dispatch({ type: "add-entry", entry: createEntry(name, parsedQuantity, parsedPrice, valuation) });
        setQuantity("1");
    }

    function startOrResume() {
        const timestamp = Date.now();
        setNow(timestamp);
        dispatch({ type: session.status === "paused" ? "resume" : "start", now: timestamp });
    }

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="brand">
                    <div className="brand-mark">SS</div>
                    <div>
                        <strong>Shakatu</strong>
                        <span>Sheets</span>
                    </div>
                </div>
                <div className={`database-state ${databaseStatus}`}>
                    <div className="status-heading">
                        <span className="status-dot" /> Local database
                    </div>
                    <strong>{databaseStatus}</strong>
                    <small>{databaseError || "Session data stored on this device"}</small>
                </div>
                <div className="license-note">
                    Local only <span>AGPL-3.0</span>
                </div>
            </aside>

            <main className="workspace">
                <header className="topbar">
                    <div>
                        <p className="eyebrow">Live grind ledger</p>
                        <h1>{sycraiaLower.name}</h1>
                    </div>
                    <div className="session-meta">
                        <label>
                            Region
                            <select
                                value={session.region}
                                disabled={editingDisabled || fetchingPrices}
                                onChange={(event) => changeRegion(event.target.value as SessionState["region"])}
                            >
                                <option value="eu">EU</option>
                                <option value="na">NA</option>
                            </select>
                        </label>
                        <span className={`session-state ${session.status}`}>{session.status}</span>
                    </div>
                </header>

                <section className="metrics-grid" aria-label="Session summary">
                    <article className="metric primary">
                        <span>Net silver / hour</span>
                        <strong>{formatSilver(totals.netPerHour, true)}</strong>
                        <small>after market tax and expenses</small>
                    </article>
                    <article className="metric">
                        <span>Session net</span>
                        <strong>{formatSilver(totals.net, true)}</strong>
                        <small>{formatSilver(totals.net)} silver</small>
                    </article>
                    <article className="metric">
                        <span>Gross value</span>
                        <strong>{formatSilver(totals.gross, true)}</strong>
                        <small>before deductions</small>
                    </article>
                    <article className="metric">
                        <span>Expenses</span>
                        <strong>{formatSilver(totals.expenses, true)}</strong>
                        <small>consumables and fees</small>
                    </article>
                </section>

                <section className="session-clock">
                    <div>
                        <span>Elapsed session</span>
                        <time>{formatDuration(elapsedMs)}</time>
                    </div>
                    <div className="clock-actions">
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
                        {(session.status === "running" || session.status === "paused") && (
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

                <section className="market-snapshot" aria-live="polite">
                    <div>
                        <p className="eyebrow">Manual market snapshot</p>
                        {marketPrices === null ? (
                            <strong>Reading saved {session.region.toUpperCase()} prices...</strong>
                        ) : currentMarketPrices.length === 0 ? (
                            <>
                                <strong>No {session.region.toUpperCase()} prices saved</strong>
                                <span>Fetch once from Arsha, or continue with manual unit prices.</span>
                            </>
                        ) : (
                            <>
                                <strong>
                                    {session.region.toUpperCase()} prices from {formatTimestamp(lastPriceFetch)}
                                </strong>
                                <span>
                                    {currentMarketPrices.length} of {marketItemIds.length} profile items saved locally.
                                </span>
                            </>
                        )}
                        {marketError && <span className="market-error">{marketError}</span>}
                    </div>
                    <button
                        className="button"
                        type="button"
                        disabled={!databaseLoaded || fetchingPrices || marketPrices === null}
                        onClick={fetchMarketPrices}
                    >
                        {fetchingPrices
                            ? "Fetching..."
                            : currentMarketPrices.length === 0
                              ? "Fetch from Arsha"
                              : "Refresh prices"}
                    </button>
                </section>

                <div className="content-grid">
                    <section className="panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Session entries</p>
                                <h2>Loot ledger</h2>
                            </div>
                            <span>{session.entries.length} entries</span>
                        </div>
                        {session.entries.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-glyph">+</div>
                                <strong>No loot recorded yet</strong>
                                <p>Start the timer and add drops as they arrive.</p>
                            </div>
                        ) : (
                            <div className="ledger-list">
                                {session.entries
                                    .slice()
                                    .reverse()
                                    .map((entry) => (
                                        <div className="ledger-row" key={entry.id}>
                                            <div className={`item-swatch ${entry.valuation}`}>
                                                {entry.valuation === "expense" ? "-" : "+"}
                                            </div>
                                            <div className="item-name">
                                                <strong>{entry.name}</strong>
                                                <span>{entry.valuation}</span>
                                            </div>
                                            <span className="quantity">x{formatSilver(entry.quantity)}</span>
                                            <strong className={entry.valuation === "expense" ? "negative" : ""}>
                                                {entry.valuation === "expense" ? "-" : ""}
                                                {formatSilver(entry.quantity * entry.unitPrice, true)}
                                            </strong>
                                            <button
                                                className="remove-button"
                                                type="button"
                                                disabled={editingDisabled}
                                                aria-label={`Remove ${entry.name}`}
                                                onClick={() => dispatch({ type: "remove-entry", id: entry.id })}
                                            >
                                                x
                                            </button>
                                        </div>
                                    ))}
                            </div>
                        )}
                    </section>

                    <aside className="panel entry-panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Manual input</p>
                                <h2>Add to session</h2>
                            </div>
                        </div>
                        <div className="quick-items">
                            <button
                                className={selectedDrop.name === sycraiaLower.trash.name ? "selected" : ""}
                                type="button"
                                disabled={editingDisabled}
                                onClick={() => chooseDrop(sycraiaLower.trash)}
                            >
                                {sycraiaLower.trash.name}
                            </button>
                            {sycraiaLower.drops.map((drop) => (
                                <button
                                    key={drop.name}
                                    className={selectedDrop.name === drop.name ? "selected" : ""}
                                    type="button"
                                    disabled={editingDisabled}
                                    onClick={() => chooseDrop(drop)}
                                >
                                    {drop.name}
                                </button>
                            ))}
                        </div>
                        <form onSubmit={addEntry}>
                            <label>
                                Item or expense
                                <input
                                    value={customName}
                                    disabled={editingDisabled}
                                    placeholder={selectedDrop.name}
                                    onChange={(event) => setCustomName(event.target.value)}
                                />
                            </label>
                            <div className="form-row">
                                <label>
                                    Quantity
                                    <input
                                        type="number"
                                        min="0"
                                        step="1"
                                        required
                                        value={quantity}
                                        disabled={editingDisabled}
                                        onChange={(event) => setQuantity(event.target.value)}
                                    />
                                </label>
                                <label>
                                    Unit price
                                    <input
                                        type="number"
                                        min="0"
                                        step="1"
                                        required
                                        value={unitPrice}
                                        disabled={editingDisabled}
                                        placeholder="Required"
                                        onChange={(event) => setUnitPrice(event.target.value)}
                                    />
                                </label>
                            </div>
                            <label>
                                Valuation
                                <select
                                    value={valuation}
                                    disabled={editingDisabled}
                                    onChange={(event) => setValuation(event.target.value as Valuation)}
                                >
                                    <option value="market">Market (84.5%)</option>
                                    <option value="vendor">Vendor (100%)</option>
                                    <option value="expense">Expense</option>
                                </select>
                            </label>
                            <button
                                className="button primary-button add-button"
                                type="submit"
                                disabled={editingDisabled}
                            >
                                Add entry
                            </button>
                        </form>
                        <p className="data-note">
                            Saved market prices change only when you fetch them. Unit prices remain editable, and
                            entries keep the price used when they were added.
                        </p>
                    </aside>
                </div>
            </main>
        </div>
    );
}
