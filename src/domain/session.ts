export type SessionStatus = "idle" | "running" | "paused" | "finished";
export type Valuation = "market" | "vendor" | "expense";

export type SessionEntry = {
    id: string;
    name: string;
    quantity: number;
    unitPrice: number;
    valuation: Valuation;
    saleMultiplier: number;
    source: "manual" | "recognition";
    createdAt: number;
};

export type SessionState = {
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
    | { type: "set-region"; region: SessionState["region"] }
    | { type: "add-entry"; entry: SessionEntry }
    | { type: "remove-entry"; id: string };

export const initialSession: SessionState = {
    status: "idle",
    region: "eu",
    grindSpotId: "sycraia-lower-revamp",
    startedAt: null,
    elapsedMs: 0,
    entries: [],
};

export function reduceSession(state: SessionState, action: SessionAction): SessionState {
    switch (action.type) {
        case "start":
            return { ...state, status: "running", startedAt: action.now };
        case "pause":
            if (state.status !== "running" || state.startedAt === null) return state;
            return {
                ...state,
                status: "paused",
                elapsedMs: state.elapsedMs + action.now - state.startedAt,
                startedAt: null,
            };
        case "resume":
            return state.status === "paused" ? { ...state, status: "running", startedAt: action.now } : state;
        case "finish":
            return {
                ...state,
                status: "finished",
                elapsedMs: getElapsedMs(state, action.now),
                startedAt: null,
            };
        case "reset":
            return { ...initialSession, region: state.region };
        case "set-region":
            return { ...state, region: action.region };
        case "add-entry":
            return { ...state, entries: [...state.entries, action.entry] };
        case "remove-entry":
            return { ...state, entries: state.entries.filter((entry) => entry.id !== action.id) };
        default:
            return state;
    }
}

export function getElapsedMs(state: SessionState, now: number): number {
    if (state.status !== "running" || state.startedAt === null) return state.elapsedMs;
    return state.elapsedMs + now - state.startedAt;
}

export function calculateTotals(entries: SessionEntry[], elapsedMs: number) {
    const gross = entries.reduce(
        (total, entry) => total + (entry.valuation === "expense" ? 0 : entry.quantity * entry.unitPrice),
        0,
    );
    const expenses = entries.reduce(
        (total, entry) => total + (entry.valuation === "expense" ? entry.quantity * entry.unitPrice : 0),
        0,
    );
    const netRevenue = entries.reduce(
        (total, entry) =>
            total + (entry.valuation === "expense" ? 0 : entry.quantity * entry.unitPrice * entry.saleMultiplier),
        0,
    );
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
        source: "manual",
        createdAt: Date.now(),
    };
}
