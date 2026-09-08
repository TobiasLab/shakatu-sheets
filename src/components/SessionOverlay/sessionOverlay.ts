import type { SessionEntry, SessionState } from "../../domain/session";
import type { Theme } from "../../hooks/useTheme";

export const OVERLAY_STATE = "session-overlay-state";
export const OVERLAY_READY = "session-overlay-ready";
export type OverlaySnapshot = { session: SessionState; theme: Theme };

export function aggregateDrops(entries: SessionEntry[]) {
    const quantities = new Map<string, number>();
    for (const entry of entries) {
        if (entry.valuation === "expense") continue;
        quantities.set(entry.name, (quantities.get(entry.name) ?? 0) + entry.quantity);
    }
    return Array.from(quantities, ([name, quantity]) => ({ name, quantity }));
}
