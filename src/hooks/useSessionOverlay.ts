import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { OVERLAY_READY, OVERLAY_STATE, type OverlaySnapshot } from "../components/SessionOverlay/sessionOverlay";

export function useSessionOverlay(snapshot: OverlaySnapshot) {
    const { session, theme } = snapshot;
    const latest = useRef(snapshot);
    const [error, setError] = useState("");
    useEffect(() => {
        latest.current = { session, theme };
        if (isTauri()) {
            void emitTo("session-overlay", OVERLAY_STATE, { session, theme }).catch((error) => setError(String(error)));
        }
    }, [session, theme]);
    useEffect(() => {
        if (!isTauri()) return;
        const stop = listen(OVERLAY_READY, () => {
            void emitTo("session-overlay", OVERLAY_STATE, latest.current).catch((error) => setError(String(error)));
        });
        void stop.catch((error) => setError(String(error)));
        return () => {
            void stop.then((unlisten) => unlisten()).catch(() => undefined);
        };
    }, []);

    async function openOverlay() {
        setError("");
        try {
            const overlay = await Window.getByLabel("session-overlay");
            if (!overlay) throw new Error("Session overlay window is unavailable. Restart the desktop app.");
            await emitTo("session-overlay", OVERLAY_STATE, latest.current);
            await overlay.show();
            await overlay.setFocus();
        } catch (error) {
            setError(`Could not open overlay: ${String(error)}`);
        }
    }
    return { openOverlay, error, available: isTauri() };
}
