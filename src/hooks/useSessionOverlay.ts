import { isTauri } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import {
    OVERLAY_READY,
    OVERLAY_STATE,
    OVERLAY_VISIBILITY_CHANGED,
    type OverlaySnapshot,
} from "../components/SessionOverlay/sessionOverlay";

export function useSessionOverlay(snapshot: OverlaySnapshot) {
    const { session, theme } = snapshot;
    const latest = useRef(snapshot);
    const visible = useRef(false);
    const [error, setError] = useState("");
    useEffect(() => {
        latest.current = { session, theme };
        if (isTauri() && visible.current) {
            void emitTo("session-overlay", OVERLAY_STATE, { session, theme }).catch((error) => setError(String(error)));
        }
    }, [session, theme]);
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
        const stops = [listen(OVERLAY_READY, refresh), listen(OVERLAY_VISIBILITY_CHANGED, refresh)];
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
            await overlay.setFocus();
        } catch (error) {
            setError(`Could not open overlay: ${String(error)}`);
        }
    }
    return { openOverlay, error, available: isTauri() };
}
