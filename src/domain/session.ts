export type SessionStatus = "idle" | "running" | "paused" | "finished";
export type Valuation = "market" | "vendor" | "expense";

export type SessionEntry = {
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    valuation: Valuation;
    saleMultiplier: number;
    createdAt: number;
};

export type SessionState = {
    id: string;
    status: SessionStatus;
    region: "eu" | "na";
    grindSpotId: string;
    startedAt: number | null;
    elapsedMs: number;
    entries: SessionEntry[];
};

export type SessionAction =
    | { type: "start"; now: number }
    | { type: "pause"; now: number }
    | { type: "resume"; now: number }
    | { type: "finish"; now: number }
    | { type: "set-elapsed"; elapsedMs: number }
    | { type: "reset" }
    | { type: "hydrate"; session: SessionState }
    | { type: "set-region"; region: SessionState["region"] }
    | { type: "set-grind-spot"; grindSpotId: string }
    | { type: "add-entry"; entry: SessionEntry }
    | { type: "update-entry"; id: string; quantity: number; unitPrice: number }
    | { type: "remove-entry"; id: string };

export function createSession(region: SessionState["region"] = "eu"): SessionState {
    return {
        id: crypto.randomUUID(),
        status: "idle",
        region,
        grindSpotId: "sycraia-lower-revamp",
        startedAt: null,
        elapsedMs: 0,
        entries: [],
    };
}

export function reduceSession(state: SessionState, action: SessionAction): SessionState {
    switch (action.type) {
        case "start":
            return state.status === "idle" ? { ...state, status: "running", startedAt: action.now } : state;
        case "pause":
            if (state.status !== "running" || state.startedAt === null) return state;
            return {
                ...state,
                status: "paused",
                elapsedMs: getElapsedMs(state, action.now),
                startedAt: null,
            };
        case "resume":
            return state.status === "paused" ? { ...state, status: "running", startedAt: action.now } : state;
        case "finish":
            if (
                state.status !== "running" &&
                state.status !== "paused" &&
                (state.status !== "idle" || state.elapsedMs === 0)
            )
                return state;
            return {
                ...state,
                status: "finished",
                elapsedMs: getElapsedMs(state, action.now),
                startedAt: null,
            };
        case "set-elapsed":
            return state.status === "running" ||
                state.status === "finished" ||
                !Number.isSafeInteger(action.elapsedMs) ||
                action.elapsedMs < 0
                ? state
                : { ...state, elapsedMs: action.elapsedMs };
        case "reset":
            return state.status === "finished" ? createSession(state.region) : state;
        case "hydrate":
            return action.session;
        case "set-region":
            return state.status === "finished" ? state : { ...state, region: action.region };
        case "set-grind-spot":
            return state.status === "idle" && state.elapsedMs === 0 && state.entries.length === 0
                ? { ...state, grindSpotId: action.grindSpotId }
                : state;
        case "add-entry": {
            if (state.status === "finished") return state;
            const matchingEntries = state.entries.filter(
                (entry) =>
                    entry.name === action.entry.name &&
                    entry.valuation === action.entry.valuation &&
                    entry.unitPrice === action.entry.unitPrice,
            );
            if (matchingEntries.length === 0) return { ...state, entries: [...state.entries, action.entry] };
            const quantity = matchingEntries.reduce((total, entry) => total + entry.quantity, action.entry.quantity);
            if (!Number.isSafeInteger(quantity)) return state;
            const existing = matchingEntries[0];
            const matchingIds = new Set(matchingEntries.map((entry) => entry.id));
            return {
                ...state,
                entries: [
                    ...state.entries.filter((entry) => !matchingIds.has(entry.id)),
                    { ...existing, quantity, createdAt: action.entry.createdAt },
                ],
            };
        }
        case "update-entry": {
            if (
                state.status === "finished" ||
                !Number.isSafeInteger(action.quantity) ||
                action.quantity <= 0 ||
                !Number.isSafeInteger(action.unitPrice) ||
                action.unitPrice < 0
            )
                return state;
            const existing = state.entries.find((entry) => entry.id === action.id);
            if (!existing || (existing.quantity === action.quantity && existing.unitPrice === action.unitPrice)) {
                return state;
            }
            return {
                ...state,
                entries: state.entries.map((entry) =>
                    entry.id === action.id
                        ? { ...entry, quantity: action.quantity, unitPrice: action.unitPrice }
                        : entry,
                ),
            };
        }
        case "remove-entry":
            return state.status === "finished"
                ? state
                : { ...state, entries: state.entries.filter((entry) => entry.id !== action.id) };
        default:
            return state;
    }
}

export function pauseRestoredSession(session: SessionState, now: number): SessionState {
    if (session.status !== "running" || session.startedAt === null) return session;
    return {
        ...session,
        status: "paused",
        elapsedMs: getElapsedMs(session, now),
        startedAt: null,
    };
}

export function getElapsedMs(state: SessionState, now: number): number {
    if (state.status !== "running" || state.startedAt === null) return state.elapsedMs;
    return state.elapsedMs + Math.max(0, now - state.startedAt);
}

export function calculateTotals(entries: SessionEntry[], elapsedMs: number) {
    let gross = 0;
    let expenses = 0;
    let netRevenue = 0;
    for (const entry of entries) {
        const value = entry.quantity * entry.unitPrice;
        if (entry.valuation === "expense") {
            expenses += value;
        } else {
            gross += value;
            netRevenue += value * entry.saleMultiplier;
        }
    }
    const net = netRevenue - expenses;
    const hours = elapsedMs / 3_600_000;

    return {
        gross,
        expenses,
        net,
        netPerHour: hours > 0 ? net / hours : 0,
    };
}

export function createEntry(name: string, quantity: number, unitPrice: number, valuation: Valuation): SessionEntry {
    return {
        id: crypto.randomUUID(),
        name,
        quantity,
        unitPrice,
        valuation,
        saleMultiplier: valuation === "market" ? 0.845 : 1,
        createdAt: Date.now(),
    };
}
