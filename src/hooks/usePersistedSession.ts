import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { loadActiveSession, saveSession, supportsTauriApi } from "../api/tauri";
import { createSession, pauseRestoredSession, reduceSession } from "../domain/session";

import { createSessionPersistence } from "./sessionPersistence";

export type DatabaseStatus = "loading" | "ready" | "saving" | "error";

export function usePersistedSession() {
    const [session, dispatch] = useReducer(reduceSession, undefined, () => createSession());
    const [databaseLoaded, setDatabaseLoaded] = useState(false);
    const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("loading");
    const [databaseError, setDatabaseError] = useState("");
    const persistenceQueue = useRef(createSessionPersistence(saveSession));
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
        loadActiveSession()
            .then((storedSession) => {
                if (cancelled) return;
                const restoredSession = storedSession
                    ? pauseRestoredSession(storedSession, Date.now())
                    : createSession();
                dispatch({ type: "hydrate", session: restoredSession });
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
        setDatabaseStatus("saving");
        void persistenceQueue.current
            .enqueue(session)
            .then(() => {
                setDatabaseError("");
                setDatabaseStatus("ready");
            })
            .catch((error: unknown) => {
                setDatabaseError(String(error));
                setDatabaseStatus("error");
            });
    }, [session, databaseLoaded]);

    return { session, dispatch, databaseLoaded, databaseStatus, databaseError, closing };
}
