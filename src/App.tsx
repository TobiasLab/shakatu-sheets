import { useLayoutEffect, useState } from "react";
import { reopenSession } from "./api/tauri";
import { AppShell, type AppView } from "./components/AppShell/AppShell";
import { useLiveSession } from "./hooks/useLiveSession";
import { useLootFont } from "./hooks/useLootFont";
import { useOverlayOpacity } from "./hooks/useOverlayOpacity";
import { usePersistedSession } from "./hooks/usePersistedSession";
import { useSessionOverlay } from "./hooks/useSessionOverlay";
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
    const overlayOpacity = useOverlayOpacity();
    const lootFont = useLootFont();
    const persistedSession = usePersistedSession(async () => {
        await Promise.all([overlayOpacity.flush(), lootFont.flush()]);
    });
    const liveSession = useLiveSession(
        persistedSession.session,
        persistedSession.dispatch,
        persistedSession.databaseLoaded,
    );

    const overlay = useSessionOverlay(
        {
            session: persistedSession.session,
            theme,
            opacity: overlayOpacity.opacity,
            timerEnabled: persistedSession.databaseLoaded && !persistedSession.closing,
        },
        persistedSession.requestOverlayTimer,
    );

    function openCaptureSetup() {
        setView("live");
        setCaptureSetupRequest((request) => request + 1);
    }

    async function reopenFinishedSession(id: string) {
        const session = await reopenSession(id);
        persistedSession.dispatch({ type: "hydrate", session });
        setView("live");
    }

    return (
        <div inert={persistedSession.closing}>
            <AppShell
                view={view}
                onViewChange={setView}
                databaseStatus={persistedSession.databaseStatus}
                databaseError={persistedSession.databaseError}
                sessionStatus={persistedSession.session.status}
                captureStatus={captureStatus}
                spotName={liveSession.spot.name}
                onOpenCapture={openCaptureSetup}
            >
                <div hidden={view !== "live"}>
                    <LiveSessionView
                        controller={liveSession}
                        lootFont={lootFont.font}
                        lootFontReady={lootFont.loaded && !lootFont.saving && !lootFont.error}
                        overlay={overlay}
                        onOpenHistory={() => setView("history")}
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
                        onOpenCapture={openCaptureSetup}
                        overlayOpacity={overlayOpacity}
                        lootFont={lootFont}
                    />
                ) : null}
            </AppShell>
        </div>
    );
}
