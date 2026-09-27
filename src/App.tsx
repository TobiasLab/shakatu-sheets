import { useLayoutEffect, useState } from "react";
import { reopenSession } from "./api/tauri";
import { AppShell, type AppView } from "./components/AppShell/AppShell";
import { focusLootReview } from "./components/LiveLootCapture/LootReview";
import type { CaptureSummary } from "./components/LiveLootCapture/useLiveLootCapture";
import { useLiveSession } from "./hooks/useLiveSession";
import { useLootFont } from "./hooks/useLootFont";
import { useOverlayOpacity } from "./hooks/useOverlayOpacity";
import { usePersistedSession } from "./hooks/usePersistedSession";
import { useSelfImprovement } from "./hooks/useSelfImprovement";
import { useSessionOverlay } from "./hooks/useSessionOverlay";
import { useTheme } from "./hooks/useTheme";
import { HistoryView } from "./views/History/History";
import { LiveSessionView } from "./views/LiveSession/LiveSession";
import { SettingsView } from "./views/Settings/Settings";

export function App() {
    const [captureSetupRequest, setCaptureSetupRequest] = useState(0);
    const [captureStatus, setCaptureStatus] = useState<CaptureSummary>({
        label: "Capture off",
        tone: "idle",
        pendingReviews: 0,
    });
    const [view, setView] = useState<AppView>("live");
    const { theme, setTheme } = useTheme();
    useLayoutEffect(() => {
        window.scrollTo(0, 0);
    }, [view]);
    const overlayOpacity = useOverlayOpacity();
    const lootFont = useLootFont();
    const selfImprovement = useSelfImprovement();
    const [showSelfImprovement, setShowSelfImprovement] = useState(false);
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
            pendingReviews: captureStatus.pendingReviews,
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
                onViewChange={(next) => {
                    setShowSelfImprovement(false);
                    setView(next);
                }}
                databaseStatus={persistedSession.databaseStatus}
                databaseError={persistedSession.databaseError}
                session={persistedSession.session}
                captureStatus={captureStatus}
                onOpenReview={() => {
                    setShowSelfImprovement(false);
                    setView("live");
                    // The desk becomes visible on the next render.
                    requestAnimationFrame(focusLootReview);
                }}
                spotName={liveSession.spot.name}
            >
                <div hidden={view !== "live"}>
                    <LiveSessionView
                        controller={liveSession}
                        saved={persistedSession.databaseStatus === "ready"}
                        selfImprovement={selfImprovement}
                        onOpenSelfImprovement={() => {
                            setShowSelfImprovement(true);
                            setView("settings");
                        }}
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
                        initialRegion={persistedSession.session.region}
                        databaseLoaded={persistedSession.databaseLoaded}
                        databaseStatus={persistedSession.databaseStatus}
                        onReopen={reopenFinishedSession}
                        onSessionCorrected={(session) => {
                            if (
                                persistedSession.session.id === session.id &&
                                persistedSession.session.status === "finished"
                            ) {
                                persistedSession.dispatch({ type: "hydrate", session });
                            }
                        }}
                        onOpenSettings={() => setView("settings")}
                    />
                ) : view === "settings" ? (
                    <SettingsView
                        marketController={liveSession}
                        theme={theme}
                        onThemeChange={setTheme}
                        onOpenCapture={openCaptureSetup}
                        overlayOpacity={overlayOpacity}
                        lootFont={lootFont}
                        selfImprovement={selfImprovement}
                        showSelfImprovement={showSelfImprovement}
                    />
                ) : null}
            </AppShell>
        </div>
    );
}
