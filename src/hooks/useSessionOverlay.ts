import { isTauri } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sessionOverlaySupportsOpacity, sessionOverlayUsesLayerShell } from "../api/sessionOverlay";
import {
    OVERLAY_READY,
    OVERLAY_STATE,
    OVERLAY_TIMER_REQUEST,
    OVERLAY_TIMER_RESULT,
    OVERLAY_VISIBILITY_CHANGED,
    type OverlaySnapshot,
    type OverlayTimerRequest,
} from "../components/SessionOverlay/sessionOverlay";

export function useSessionOverlay(
    snapshot: OverlaySnapshot,
    onTimerRequest: (request: OverlayTimerRequest) => string | null,
) {
    const { session, theme, timerEnabled, opacity, pendingReviews } = snapshot;
    const timerHandler = useRef(onTimerRequest);
    const latest = useRef(snapshot);
    const visible = useRef(false);
    const [error, setError] = useState("");
    const [supportsOpacity, setSupportsOpacity] = useState(false);
    useLayoutEffect(() => {
        timerHandler.current = onTimerRequest;
    }, [onTimerRequest]);
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        void sessionOverlaySupportsOpacity()
            .then((supported) => {
                if (!disposed) setSupportsOpacity(supported);
            })
            .catch((error) => {
                if (!disposed) setError(String(error));
            });
        return () => {
            disposed = true;
        };
    }, []);
    useEffect(() => {
        latest.current = { session, theme, timerEnabled, opacity: supportsOpacity ? opacity : 100, pendingReviews };
        if (isTauri() && visible.current) {
            void emitTo("session-overlay", OVERLAY_STATE, latest.current).catch((error) => setError(String(error)));
        }
    }, [session, theme, timerEnabled, opacity, supportsOpacity, pendingReviews]);
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let revision = 0;
        async function refreshVisibility() {
            const request = ++revision;
            const overlay = await Window.getByLabel("session-overlay");
            const showing = overlay !== null && (await overlay.isVisible());
            if (disposed || request !== revision) return;
            visible.current = showing;
            if (showing) await emitTo("session-overlay", OVERLAY_STATE, latest.current);
        }
        const refresh = () => {
            void refreshVisibility().catch((error) => {
                if (!disposed) setError(String(error));
            });
        };
        const stops = [
            listen(OVERLAY_READY, refresh),
            listen(OVERLAY_VISIBILITY_CHANGED, refresh),
            listen<OverlayTimerRequest>(OVERLAY_TIMER_REQUEST, ({ payload }) => {
                if (disposed) return;
                const error = timerHandler.current(payload);
                void emitTo("session-overlay", OVERLAY_TIMER_RESULT, { requestId: payload.requestId, error }).catch(
                    (error) => setError(String(error)),
                );
            }),
        ];
        void Promise.all(stops)
            .then(refresh)
            .catch((error) => {
                if (!disposed) setError(String(error));
            });
        return () => {
            disposed = true;
            visible.current = false;
            for (const stop of stops) void stop.then((unlisten) => unlisten()).catch(() => undefined);
        };
    }, []);

    async function openOverlay() {
        setError("");
        try {
            const overlay = await Window.getByLabel("session-overlay");
            if (!overlay) throw new Error("Session overlay window is unavailable. Restart the desktop app.");
            await overlay.show();
            await emit(OVERLAY_VISIBILITY_CHANGED);
            if (!(await sessionOverlayUsesLayerShell())) await overlay.setFocus();
        } catch (error) {
            setError(`Could not open overlay: ${String(error)}`);
        }
    }
    return { openOverlay, error, available: isTauri(), supportsOpacity };
}
