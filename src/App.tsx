import { useLayoutEffect, useState } from "react";
import { reopenSession } from "./api/tauri";
import { AppShell, type AppView } from "./components/AppShell/AppShell";
import { useLiveSession } from "./hooks/useLiveSession";
import { usePersistedSession } from "./hooks/usePersistedSession";
import { useTheme } from "./hooks/useTheme";
import { HistoryView } from "./views/History/History";
import { LiveSessionView } from "./views/LiveSession/LiveSession";
import { SettingsView } from "./views/Settings/Settings";

export function App() {
    const [captureSetupRequest, setCaptureSetupRequest] = useState(0);
    const [captureStatus, setCaptureStatus] = useState("Capture off");
    const [view, setView] = useState<AppView>("live");
    const { theme, setTheme } = useTheme();
    useLayoutEffect(() => {
        window.scrollTo(0, 0);
    }, [view]);
    const persistedSession = usePersistedSession();
    const liveSession = useLiveSession(
        persistedSession.session,
        persistedSession.dispatch,
        persistedSession.databaseLoaded,
    );

    async function reopenFinishedSession(id: string) {
        const session = await reopenSession(id);
        persistedSession.dispatch({ type: "hydrate", session });
        setView("live");
    }

    return (
        <AppShell
            view={view}
            onViewChange={setView}
            databaseStatus={persistedSession.databaseStatus}
            databaseError={persistedSession.databaseError}
            sessionStatus={persistedSession.session.status}
            captureStatus={captureStatus}
        >
            <div hidden={view !== "live"}>
                <LiveSessionView
                    controller={liveSession}
                    visible={view === "live"}
                    captureSetupRequest={captureSetupRequest}
                    onCaptureStatusChange={setCaptureStatus}
                />
            </div>
            {view === "history" ? (
                <HistoryView
                    databaseLoaded={persistedSession.databaseLoaded}
                    databaseStatus={persistedSession.databaseStatus}
                    onReopen={reopenFinishedSession}
                    onOpenSettings={() => setView("settings")}
                />
            ) : view === "settings" ? (
                <SettingsView
                    theme={theme}
                    onThemeChange={setTheme}
                    onOpenCapture={() => {
                        setView("live");
                        setCaptureSetupRequest((request) => request + 1);
                    }}
                />
            ) : null}
        </AppShell>
    );
}
