import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
    OVERLAY_TIMER_REQUEST,
    OVERLAY_TIMER_RESULT,
    type OverlayTimerAction,
    type OverlayTimerResult,
} from "../components/SessionOverlay/sessionOverlay";

export function loadOverlayOpacity() {
    return invoke<number>("load_overlay_opacity");
}

export function saveOverlayOpacity(opacity: number) {
    return invoke<void>("save_overlay_opacity", { opacity });
}

export async function requestOverlayTimer(sessionId: string, action: OverlayTimerAction) {
    const requestId = crypto.randomUUID();
    let complete: (error: string | null) => void = () => undefined;
    const response = new Promise<string | null>((resolve) => {
        complete = resolve;
    });
    const stop = await listen<OverlayTimerResult>(OVERLAY_TIMER_RESULT, ({ payload }) => {
        if (payload.requestId === requestId) complete(payload.error);
    });
    const timeout = window.setTimeout(() => complete("The main window did not respond. Try again."), 5_000);
    try {
        await emitTo("main", OVERLAY_TIMER_REQUEST, { requestId, sessionId, action });
        const error = await response;
        if (error) throw new Error(error);
    } finally {
        window.clearTimeout(timeout);
        stop();
    }
}
