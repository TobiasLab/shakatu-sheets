import { useState } from "react";
import { AppShell, type AppView } from "./components/AppShell/AppShell";
import { useLiveSession } from "./hooks/useLiveSession";
import { usePersistedSession } from "./hooks/usePersistedSession";
import { HistoryView } from "./views/History/History";
import { LiveSessionView } from "./views/LiveSession/LiveSession";

export function App() {
    const [view, setView] = useState<AppView>("live");
    const persistedSession = usePersistedSession();
    const liveSession = useLiveSession(
        persistedSession.session,
        persistedSession.dispatch,
        persistedSession.databaseLoaded,
    );

    return (
        <AppShell
            view={view}
            onViewChange={setView}
            databaseStatus={persistedSession.databaseStatus}
            databaseError={persistedSession.databaseError}
        >
            {view === "history" ? (
                <HistoryView
                    databaseLoaded={persistedSession.databaseLoaded}
                    databaseStatus={persistedSession.databaseStatus}
                />
            ) : (
                <LiveSessionView controller={liveSession} />
            )}
        </AppShell>
    );
}
