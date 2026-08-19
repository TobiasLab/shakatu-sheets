import { type FormEvent, useEffect, useReducer, useState } from "react";
import { type DropTemplate, initialCaptureProfile, sycraiaLower } from "./data/grindSpots";
import {
    calculateTotals,
    createEntry,
    getElapsedMs,
    initialSession,
    reduceSession,
    type SessionState,
    type Valuation,
} from "./domain/session";
import "./App.css";

const STORAGE_KEY = "shakatu-sheets.current-session.v1";

function restoreSession(): SessionState {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return initialSession;

        const saved = { ...initialSession, ...JSON.parse(stored) } as SessionState;
        if (saved.status !== "running" || saved.startedAt === null) return saved;

        return {
            ...saved,
            status: "paused",
            elapsedMs: saved.elapsedMs + Date.now() - saved.startedAt,
            startedAt: null,
        };
    } catch {
        return initialSession;
    }
}

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

export function App() {
    const [session, dispatch] = useReducer(reduceSession, undefined, restoreSession);
    const [now, setNow] = useState(Date.now());
    const [selectedDrop, setSelectedDrop] = useState<DropTemplate>(sycraiaLower.trash);
    const [quantity, setQuantity] = useState("1");
    const [unitPrice, setUnitPrice] = useState(String(sycraiaLower.trash.unitPrice));
    const [customName, setCustomName] = useState("");
    const [valuation, setValuation] = useState<Valuation>("vendor");

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    }, [session]);

    useEffect(() => {
        if (session.status !== "running") return;
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [session.status]);

    const elapsedMs = getElapsedMs(session, now);
    const totals = calculateTotals(session.entries, elapsedMs);

    function chooseDrop(drop: DropTemplate) {
        setSelectedDrop(drop);
        setCustomName(drop.name);
        setValuation(drop.valuation);
        setUnitPrice(drop.unitPrice === null ? "" : String(drop.unitPrice));
        setQuantity("1");
    }

    function addEntry(event: FormEvent) {
        event.preventDefault();
        const name = customName.trim() || selectedDrop.name;
        const parsedQuantity = Number(quantity);
        const parsedPrice = Number(unitPrice);
        if (!name || parsedQuantity <= 0 || parsedPrice < 0 || !Number.isFinite(parsedPrice)) return;
        dispatch({ type: "add-entry", entry: createEntry(name, parsedQuantity, parsedPrice, valuation) });
        setQuantity("1");
    }

    function startOrResume() {
        setNow(Date.now());
        dispatch({ type: session.status === "paused" ? "resume" : "start", now: Date.now() });
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
                <nav aria-label="Primary navigation">
                    <button className="nav-item active" type="button">
                        <span>01</span> Live session
                    </button>
                    <button className="nav-item" type="button" disabled>
                        <span>02</span> History
                    </button>
                    <button className="nav-item" type="button" disabled>
                        <span>03</span> Settings
                    </button>
                </nav>
                <div className="capture-card">
                    <div className="capture-heading">
                        <span className="status-dot" /> Recognition profile
                    </div>
                    <strong>
                        {initialCaptureProfile.sourceWidth} x {initialCaptureProfile.sourceHeight}
                    </strong>
                    <span>
                        {initialCaptureProfile.locale.toUpperCase()} / {initialCaptureProfile.uiScale * 100}% UI scale
                    </span>
                    <small>Crop calibration pending</small>
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
                                onChange={(event) =>
                                    dispatch({ type: "set-region", region: event.target.value as "eu" | "na" })
                                }
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
                            <button className="button primary-button" type="button" onClick={startOrResume}>
                                {session.status === "paused" ? "Resume" : "Start session"}
                            </button>
                        )}
                        {session.status === "running" && (
                            <button
                                className="button"
                                type="button"
                                onClick={() => dispatch({ type: "pause", now: Date.now() })}
                            >
                                Pause
                            </button>
                        )}
                        {(session.status === "running" || session.status === "paused") && (
                            <button
                                className="button subtle"
                                type="button"
                                onClick={() => dispatch({ type: "finish", now: Date.now() })}
                            >
                                Finish
                            </button>
                        )}
                        {session.status === "finished" && (
                            <button className="button" type="button" onClick={() => dispatch({ type: "reset" })}>
                                New session
                            </button>
                        )}
                    </div>
                </section>

                <div className="content-grid">
                    <section className="panel ledger-panel">
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
                                                <span>
                                                    {entry.source} / {entry.valuation}
                                                </span>
                                            </div>
                                            <span className="quantity">x{formatSilver(entry.quantity)}</span>
                                            <strong className={entry.valuation === "expense" ? "negative" : ""}>
                                                {entry.valuation === "expense" ? "-" : ""}
                                                {formatSilver(entry.quantity * entry.unitPrice, true)}
                                            </strong>
                                            <button
                                                className="remove-button"
                                                type="button"
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
                                onClick={() => chooseDrop(sycraiaLower.trash)}
                            >
                                {sycraiaLower.trash.name}
                            </button>
                            {sycraiaLower.drops.map((drop) => (
                                <button
                                    key={drop.name}
                                    className={selectedDrop.name === drop.name ? "selected" : ""}
                                    type="button"
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
                                        value={quantity}
                                        onChange={(event) => setQuantity(event.target.value)}
                                    />
                                </label>
                                <label>
                                    Unit price
                                    <input
                                        type="number"
                                        min="0"
                                        step="1"
                                        value={unitPrice}
                                        placeholder="Required"
                                        onChange={(event) => setUnitPrice(event.target.value)}
                                    />
                                </label>
                            </div>
                            <label>
                                Valuation
                                <select
                                    value={valuation}
                                    onChange={(event) => setValuation(event.target.value as Valuation)}
                                >
                                    <option value="market">Market (84.5%)</option>
                                    <option value="vendor">Vendor (100%)</option>
                                    <option value="expense">Expense</option>
                                </select>
                            </label>
                            <button className="button primary-button add-button" type="submit">
                                Add entry
                            </button>
                        </form>
                        <p className="data-note">
                            Market prices are editable until the Arsha provider is connected. No estimated values are
                            silently applied.
                        </p>
                    </aside>
                </div>
            </main>
        </div>
    );
}
