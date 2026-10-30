import { useLayoutEffect, useRef, useState } from "react";
import { loadLootFont, saveLootFont } from "./api/lootFont";
import {
    loadSpotPreferences,
    loadTheme,
    loadTrendView,
    saveSpotPreferences,
    saveTheme,
    saveTrendView,
    type Theme,
    type TrendView,
} from "./api/preferences";
import { loadOverlayOpacity, saveOverlayOpacity } from "./api/sessionOverlay";
import { loadDebugRoiSamplesEnabled, saveDebugRoiSamplesEnabled } from "./api/tauri";
import { AppShell, type AppView } from "./components/AppShell/AppShell";
import type { SpotPreferences } from "./components/GrindSpotPicker/preferences";
import { focusLootReview } from "./components/LiveLootCapture/LootReview";
import type { CaptureSummary } from "./components/LiveLootCapture/useLiveLootCapture";
import { useLiveSession } from "./hooks/useLiveSession";
import { usePersistedSession } from "./hooks/usePersistedSession";
import { usePersistedSetting } from "./hooks/usePersistedSetting";
import { useSelfImprovement } from "./hooks/useSelfImprovement";
import { useSessionOverlay } from "./hooks/useSessionOverlay";
import type { LootFont } from "./recognition/lootFont";
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
    const theme = usePersistedSetting<Theme>("dark", loadTheme, saveTheme, "theme");
    const spotPreferences = usePersistedSetting<SpotPreferences>(
        { favorites: [], recent: [] },
        loadSpotPreferences,
        saveSpotPreferences,
        "grind spot favorites",
        true,
    );
    const overlayOpacity = usePersistedSetting(100, loadOverlayOpacity, saveOverlayOpacity, "opacity");
    const trendView = usePersistedSetting<TrendView>("net", loadTrendView, saveTrendView, "graph view");
    // Capture must not guess the in-game font, so a failed load stays unready until a font is saved.
    const lootFont = usePersistedSetting<LootFont>("korean", loadLootFont, saveLootFont, "in-game font", true);
    const debugRoiSamples = usePersistedSetting(
        false,
        loadDebugRoiSamplesEnabled,
        saveDebugRoiSamplesEnabled,
        "ROI sample recording",
    );
    const selfImprovement = useSelfImprovement();
    const [showSelfImprovement, setShowSelfImprovement] = useState(false);
    const stopCaptureRef = useRef<(() => void) | null>(null);
    const persistedSession = usePersistedSession(async () => {
        stopCaptureRef.current?.();
        const flushes = [
            overlayOpacity.flush(),
            lootFont.flush(),
            theme.flush(),
            spotPreferences.flush(),
            debugRoiSamples.flush(),
            trendView.flush(),
        ];
        // Without a loaded database a failing save must not keep the window open; pending saves still get their chance.
        if (persistedSession.databaseLoaded) await Promise.all(flushes);
        else await Promise.allSettled(flushes);
    });
    const liveSession = useLiveSession(
        persistedSession.session,
        persistedSession.dispatch,
        persistedSession.databaseLoaded,
    );

    const overlay = useSessionOverlay(
        {
            session: persistedSession.session,
            theme: theme.value,
            opacity: overlayOpacity.value,
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
        await persistedSession.reopen(id);
        setView("live");
    }

    useLayoutEffect(() => {
        document.documentElement.dataset.theme = theme.value;
    }, [theme.value]);

    // The app renders only after the saved theme loads, so its content never appears in the wrong theme.
    if (!theme.loaded) return null;

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
                        lootFont={lootFont.value}
                        lootFontReady={lootFont.loaded && !lootFont.saving && !lootFont.error}
                        debugRoiSamples={debugRoiSamples.value}
                        overlay={overlay}
                        spotPreferences={spotPreferences}
                        trendView={trendView.value}
                        onTrendViewChange={trendView.update}
                        onOpenHistory={() => setView("history")}
                        visible={view === "live"}
                        captureSetupRequest={captureSetupRequest}
                        onCaptureStatusChange={setCaptureStatus}
                        stopCaptureRef={stopCaptureRef}
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
                        trendView={trendView.value}
                        onTrendViewChange={trendView.update}
                    />
                ) : view === "settings" ? (
                    <SettingsView
                        marketController={liveSession}
                        theme={theme}
                        spotPreferences={spotPreferences}
                        onOpenCapture={openCaptureSetup}
                        overlayOpacity={overlay.supportsOpacity ? overlayOpacity : null}
                        lootFont={lootFont}
                        debugRoiSamples={import.meta.env.DEV ? debugRoiSamples : null}
                        selfImprovement={selfImprovement}
                        showSelfImprovement={showSelfImprovement}
                    />
                ) : null}
            </AppShell>
        </div>
    );
}
