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
    | { type: "reset" }
    | { type: "hydrate"; session: SessionState }
    | { type: "set-region"; region: SessionState["region"] }
    | { type: "add-entry"; entry: SessionEntry }
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
            if (state.status !== "running" && state.status !== "paused") return state;
            return {
                ...state,
                status: "finished",
                elapsedMs: getElapsedMs(state, action.now),
                startedAt: null,
            };
        case "reset":
            return state.status === "finished" ? createSession(state.region) : state;
        case "hydrate":
            return action.session;
        case "set-region":
            return state.status === "finished" ? state : { ...state, region: action.region };
        case "add-entry":
            return state.status === "finished" ? state : { ...state, entries: [...state.entries, action.entry] };
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
