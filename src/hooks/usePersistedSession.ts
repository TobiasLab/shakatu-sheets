import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { listFinishedSessions, loadActiveSession, reopenSession, saveSession, supportsTauriApi } from "../api/tauri";
import type { OverlayTimerRequest } from "../components/SessionOverlay/sessionOverlay";
import { grindSpots } from "../data/grindSpots";
import { createSession, pauseRestoredSession, reduceSession, type SessionState } from "../domain/session";

import { createSessionPersistence } from "./sessionPersistence";

export type DatabaseStatus = "loading" | "ready" | "saving" | "error";

export function usePersistedSession(beforeClose?: () => Promise<void>) {
    const beforeCloseRef = useRef(beforeClose);
    useLayoutEffect(() => {
        beforeCloseRef.current = beforeClose;
    }, [beforeClose]);
    const [session, dispatch] = useReducer(reduceSession, undefined, () => createSession());
    const [databaseLoaded, setDatabaseLoaded] = useState(false);
    const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("loading");
    const [databaseError, setDatabaseError] = useState("");
    const saveErrors = useRef(new Map<string, string>());
    const persistenceQueue = useRef(
        createSessionPersistence(async (snapshot) => {
            setDatabaseStatus("saving");
            try {
                await saveSession(snapshot);
                saveErrors.current.delete(snapshot.id);
                const outstandingError = saveErrors.current.values().next().value;
                setDatabaseError(outstandingError ?? "");
                setDatabaseStatus(outstandingError === undefined ? "ready" : "error");
            } catch (error) {
                saveErrors.current.set(snapshot.id, String(error));
                setDatabaseError(String(error));
                setDatabaseStatus("error");
                throw error;
            }
        }),
    );
    const [closing, setClosing] = useState(false);
    const closingRef = useRef(false);

    useEffect(() => {
        if (!supportsTauriApi()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void import("@tauri-apps/api/window")
            .then(async ({ getCurrentWindow }) => {
                const windowHandle = getCurrentWindow();
                const stop = await windowHandle.onCloseRequested(async (event) => {
                    event.preventDefault();
                    if (closingRef.current) return;
                    closingRef.current = true;
                    setClosing(true);
                    window.dispatchEvent(new Event("shakatu-stop-capture"));
                    try {
                        await beforeCloseRef.current?.();
                        await persistenceQueue.current.flush();
                        await windowHandle.destroy();
                    } catch (error) {
                        setDatabaseError(`Could not save before closing: ${String(error)}. Close again to retry.`);
                        setDatabaseStatus("error");
                        closingRef.current = false;
                        setClosing(false);
                    }
                });
                if (disposed) stop();
                else unlisten = stop;
            })
            .catch((error) => {
                if (!disposed) {
                    setDatabaseError(`Could not register safe window close: ${String(error)}`);
                    setDatabaseStatus("error");
                }
            });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        loadStartingSession()
            .then((startingSession) => {
                if (cancelled) return;
                dispatch({ type: "hydrate", session: startingSession });
                setDatabaseLoaded(true);
                setDatabaseStatus("ready");
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                setDatabaseError(String(error));
                setDatabaseStatus("error");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useLayoutEffect(() => {
        if (!databaseLoaded) return;
        void persistenceQueue.current.update(session).catch(() => undefined);
    }, [session, databaseLoaded]);

    useEffect(() => {
        if (!databaseLoaded) return;
        return persistenceQueue.current.startAutosave();
    }, [databaseLoaded]);

    function requestOverlayTimer(request: OverlayTimerRequest): string | null {
        if (!databaseLoaded || closingRef.current) return "The session is not available for timer changes.";
        if (request.sessionId !== session.id) return "The current session has changed. Try again.";
        const valid =
            (request.action === "start" && session.status === "idle") ||
            (request.action === "pause" && session.status === "running") ||
            (request.action === "resume" && session.status === "paused");
        if (!valid) return "The timer state has changed. Try again.";
        dispatch({ type: request.action, now: Date.now() });
        return null;
    }

    async function reopen(id: string) {
        // Rust judges from saved data whether the active session may be replaced, so staged edits must land first.
        await persistenceQueue.current.flush();
        dispatch({ type: "hydrate", session: await reopenSession(id) });
    }

    return { session, dispatch, databaseLoaded, databaseStatus, databaseError, closing, requestOverlayTimer, reopen };
}

export async function loadStartingSession(): Promise<SessionState> {
    const storedSession = await loadActiveSession();
    if (storedSession) return pauseRestoredSession(storedSession, Date.now());
    // A new session continues at the last finished session's spot; without history, or when that spot has left the
    // catalog, it uses the default spot.
    const history = await listFinishedSessions({
        region: null,
        grindSpotId: null,
        finishedFromMs: null,
        finishedBeforeMs: null,
        offset: 0,
        limit: 1,
    }).catch(() => null);
    const lastSession = history?.records[0]?.session;
    if (!lastSession) return createSession();
    const knownSpot = grindSpots.some((spot) => spot.id === lastSession.grindSpotId);
    return knownSpot ? createSession(lastSession.region, lastSession.grindSpotId) : createSession(lastSession.region);
}
