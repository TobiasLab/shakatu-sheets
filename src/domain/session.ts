import { validateConsumableItems } from "./consumablePreset";

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
    garmothConsumableId?: number;
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
    | { type: "import-recognition"; grindSpotId: string; elapsedMs: number; entries: SessionEntry[] }
    | { type: "apply-consumables"; entries: SessionEntry[] }
    | { type: "add-entry"; entry: SessionEntry }
    | { type: "update-entry"; id: string; quantity: number; unitPrice: number }
    | { type: "remove-entry"; id: string };

export function isActiveSessionStatus(status: SessionStatus) {
    return status !== "finished";
}

export function createSession(region: SessionState["region"] = "eu", grindSpotId = "aphrodon-temple"): SessionState {
    return {
        id: crypto.randomUUID(),
        status: "idle",
        region,
        grindSpotId,
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
            return state.status === "finished" ? createSession(state.region, state.grindSpotId) : state;
        case "hydrate":
            return action.session;
        case "set-region":
            return state.status === "finished" ? state : { ...state, region: action.region };
        case "set-grind-spot":
            return state.status === "idle" && state.elapsedMs === 0 && state.entries.length === 0
                ? { ...state, grindSpotId: action.grindSpotId }
                : state;
        case "import-recognition":
            return state.status === "idle" &&
                state.elapsedMs === 0 &&
                state.entries.length === 0 &&
                Number.isSafeInteger(action.elapsedMs) &&
                action.elapsedMs > 0 &&
                action.entries.length > 0 &&
                action.entries.every(
                    (entry) =>
                        entry.source === "recognition" &&
                        Number.isSafeInteger(entry.quantity) &&
                        entry.quantity > 0 &&
                        Number.isSafeInteger(entry.unitPrice) &&
                        entry.unitPrice >= 0,
                )
                ? { ...state, grindSpotId: action.grindSpotId, elapsedMs: action.elapsedMs, entries: action.entries }
                : state;
        case "apply-consumables": {
            if (state.status === "finished") return state;
            try {
                validateConsumableItems(
                    action.entries.map((entry) => ({
                        itemId: entry.garmothConsumableId ?? 0,
                        name: entry.name,
                        quantity: entry.quantity,
                        unitPrice: entry.unitPrice,
                    })),
                );
            } catch {
                return state;
            }
            const retained = state.entries.filter((entry) => entry.garmothConsumableId === undefined);
            const ids = new Set(retained.map((entry) => entry.id));
            for (const entry of action.entries) {
                if (
                    !entry.id ||
                    ids.has(entry.id) ||
                    entry.valuation !== "expense" ||
                    entry.source !== "manual" ||
                    entry.saleMultiplier !== 1
                )
                    return state;
                ids.add(entry.id);
            }
            return { ...state, entries: [...retained, ...action.entries] };
        }
        case "add-entry": {
            if (state.status === "finished") return state;
            const matchingEntries = state.entries.filter((entry) => entriesMerge(entry, action.entry));
            if (matchingEntries.length === 0) return { ...state, entries: [...state.entries, action.entry] };
            const quantity = mergedEntryQuantity(state.entries, action.entry);
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
            if (
                existing?.garmothConsumableId !== undefined &&
                !Number.isSafeInteger(action.quantity * action.unitPrice)
            )
                return state;
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

type MergeableEntry = Pick<SessionEntry, "garmothConsumableId" | "name" | "valuation" | "unitPrice" | "quantity">;

function entriesMerge(left: MergeableEntry, right: MergeableEntry) {
    return (
        left.garmothConsumableId === right.garmothConsumableId &&
        left.name === right.name &&
        left.valuation === right.valuation &&
        left.unitPrice === right.unitPrice
    );
}

/** The quantity `entry` reaches once added to the entries it merges with; adding is refused unless it is safe. */
export function mergedEntryQuantity(entries: SessionEntry[], entry: MergeableEntry) {
    return entries.reduce(
        (total, candidate) => (entriesMerge(candidate, entry) ? total + candidate.quantity : total),
        entry.quantity,
    );
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

export function calculateQuantityPerHour(quantity: number, elapsedMs: number): number | null {
    return elapsedMs > 0 ? quantity / (elapsedMs / 3_600_000) : null;
}

export function calculateEntryTotals(entries: SessionEntry[]) {
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
    return { gross, expenses, net: netRevenue - expenses };
}

export function calculateTotals(entries: SessionEntry[], elapsedMs: number) {
    const totals = calculateEntryTotals(entries);
    const hours = elapsedMs / 3_600_000;
    return { ...totals, netPerHour: hours > 0 ? totals.net / hours : 0 };
}

export function saleMultiplier(valuation: Valuation) {
    return valuation === "market" ? 0.845 : 1;
}

export function createEntry(name: string, quantity: number, unitPrice: number, valuation: Valuation): SessionEntry {
    return {
        id: crypto.randomUUID(),
        name,
        quantity,
        unitPrice,
        valuation,
        saleMultiplier: saleMultiplier(valuation),
        source: "manual",
        createdAt: Date.now(),
    };
}
