import type { SessionEntry, SessionState } from "../../domain/session";
import type { Theme } from "../../hooks/useTheme";

export const OVERLAY_STATE = "session-overlay-state";
export const OVERLAY_VISIBILITY_CHANGED = "session-overlay-visibility-changed";
export const OVERLAY_READY = "session-overlay-ready";
export const OVERLAY_TIMER_REQUEST = "session-overlay-timer-request";
export const OVERLAY_TIMER_RESULT = "session-overlay-timer-result";
export type OverlayTimerAction = "start" | "pause" | "resume";
export type OverlayTimerRequest = { requestId: string; sessionId: string; action: OverlayTimerAction };
export type OverlayTimerResult = { requestId: string; error: string | null };
export type OverlaySnapshot = {
    session: SessionState;
    theme: Theme;
    timerEnabled: boolean;
    opacity: number;
    pendingReviews: number;
};

export function aggregateDrops(entries: SessionEntry[]) {
    const quantities = new Map<string, number>();
    for (const entry of entries) {
        if (entry.valuation === "expense") continue;
        quantities.set(entry.name, (quantities.get(entry.name) ?? 0) + entry.quantity);
    }
    return Array.from(quantities, ([name, quantity]) => ({ name, quantity }));
}

const overlaySilverFormatter = new Intl.NumberFormat("en", { maximumFractionDigits: 2, useGrouping: false });

export function formatOverlaySilver(value: number) {
    const absolute = Math.abs(value);
    const [unit, suffix] =
        absolute >= 1e12
            ? [1e12, "T"]
            : absolute >= 1e9
              ? [1e9, "B"]
              : absolute >= 1e6
                ? [1e6, "M"]
                : absolute >= 1e3
                  ? [1e3, "K"]
                  : [1, ""];
    const precision = 100;
    // Reduce displayed precision without rounding the amount up to the next unit.
    const shortened = Math.trunc(value / (unit / precision)) / precision || 0;
    return `${overlaySilverFormatter.format(shortened)}${suffix}`;
}
