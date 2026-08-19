import { useEffect, useReducer, useRef, useState } from "react";
import { loadActiveSession, saveSession } from "../api/tauri";
import { createSession, pauseRestoredSession, reduceSession } from "../domain/session";

export type DatabaseStatus = "loading" | "ready" | "saving" | "error";

export function usePersistedSession() {
    const [session, dispatch] = useReducer(reduceSession, undefined, () => createSession());
    const [databaseLoaded, setDatabaseLoaded] = useState(false);
    const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("loading");
    const [databaseError, setDatabaseError] = useState("");
    const persistenceQueue = useRef(Promise.resolve());

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

    useEffect(() => {
        if (!databaseLoaded) return;

        persistenceQueue.current = persistenceQueue.current
            .then(async () => {
                setDatabaseStatus("saving");
                await saveSession(session);
                setDatabaseError("");
                setDatabaseStatus("ready");
            })
            .catch((error: unknown) => {
                setDatabaseError(String(error));
                setDatabaseStatus("error");
            });
    }, [session]);

    return { session, dispatch, databaseLoaded, databaseStatus, databaseError };
}
