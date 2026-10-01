import { useEffect, useRef, useState } from "react";
import { Feedback } from "../../components/Feedback/Feedback";
import { GrindSpotPicker } from "../../components/GrindSpotPicker/GrindSpotPicker";
import type { SpotPreferences } from "../../components/GrindSpotPicker/preferences";
import { Icon } from "../../components/Icon/Icon";
import { LiveLootCapture } from "../../components/LiveLootCapture/LiveLootCapture";
import { focusLootReview } from "../../components/LiveLootCapture/LootReview";
import { type CaptureSummary, useLiveLootCapture } from "../../components/LiveLootCapture/useLiveLootCapture";
import { LootLedger } from "../../components/LootLedger/LootLedger";
import { createEntry } from "../../domain/session";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
import type { LootFont } from "../../recognition/lootFont";
import { FinishReviewDialog } from "./FinishReviewDialog";
import styles from "./LiveSession.module.css";
import { SessionMetrics } from "./SessionSummary";
import { SessionTools } from "./SessionTools";

export function LiveSessionView({
    controller,
    saved,
    lootFont,
    lootFontReady,
    overlay,
    visible,
    onCaptureStatusChange,
    captureSetupRequest,
    onOpenHistory,
    selfImprovement,
    onOpenSelfImprovement,
    spotPreferences,
    onSpotPreferencesChange,
}: {
    overlay: { openOverlay: () => Promise<void>; error: string; available: boolean };
    onOpenHistory: () => void;
    selfImprovement: ReturnType<typeof useSelfImprovement>;
    onOpenSelfImprovement: () => void;
    controller: LiveSessionController;
    saved: boolean;
    lootFont: LootFont;
    lootFontReady: boolean;
    visible: boolean;
    captureSetupRequest: number;
    spotPreferences: SpotPreferences;
    onSpotPreferencesChange: (preferences: SpotPreferences) => void;
    onCaptureStatusChange: (status: CaptureSummary) => void;
}) {
    const { session, dispatch, databaseLoaded, editingDisabled, spotEditable, spot, drops, changeGrindSpot, market } =
        controller;
    function acceptCapturedLoot(itemName: string, quantity: number, source: "manual" | "recognition" = "recognition") {
        if (!databaseLoaded) return "The local database is still loading.";
        if (session.status === "finished") return "Finished sessions cannot accept more loot.";
        if (!Number.isSafeInteger(quantity) || quantity <= 0) return "Enter a positive whole-number quantity.";
        const drop = drops.find((candidate) => candidate.name === itemName);
        if (!drop) return "The item is not in the active grind-spot profile.";
        const marketPrice = market.currentMarketPrices.find((price) => price.itemId === drop.marketItemId)?.basePrice;
        const unitPrice = marketPrice ?? drop.unitPrice;
        if (unitPrice === null || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
            return "No valid price is available. Fetch prices in Settings → Market or add this item manually.";
        }
        const combinedQuantity = session.entries.reduce(
            (total, entry) =>
                entry.name === drop.name && entry.valuation === drop.valuation && entry.unitPrice === unitPrice
                    ? total + entry.quantity
                    : total,
            quantity,
        );
        if (!Number.isSafeInteger(combinedQuantity)) return "The combined item quantity is too large.";
        dispatch({
            type: "add-entry",
            entry: {
                ...createEntry(drop.name, quantity, unitPrice, drop.valuation),
                source,
            },
        });
        return null;
    }

    const capture = useLiveLootCapture({
        learning: selfImprovement,
        onOpenSelfImprovement,
        lootFont,
        lootFontReady,
        visible,
        setupRequest: captureSetupRequest,
        onStatusChange: onCaptureStatusChange,
        databaseLoaded,
        sessionId: session.id,
        sessionStatus: session.status,
        grindSpotId: session.grindSpotId,
        grindSpotName: spot.name,
        itemDictionary: drops.map((drop) => drop.name),
        onAcceptRecognition: acceptCapturedLoot,
    });
    const finishDialog = useRef<HTMLDialogElement>(null);
    const finishRequest = useRef(0);
    const completion = useRef<HTMLElement>(null);
    const focusCompletion = useRef(false);
    const [preparingReview, setPreparingReview] = useState(false);
    const [finishError, setFinishError] = useState("");
    const [dropView, setDropView] = useState<"inventory" | "ledger">("inventory");
    const unresolvedCount = capture.reviewResults.filter((entry) => !entry.accepted).length;
    useEffect(() => {
        finishDialog.current?.close();
        setPreparingReview(false);
        setFinishError("");
        return () => {
            finishRequest.current += 1;
        };
    }, [session.id]);

    function finishSession() {
        finishDialog.current?.close();
        focusCompletion.current = true;
        dispatch({ type: "finish", now: Date.now() });
    }

    // The dialog returns focus to the Finish button, which disappears once the session is finished.
    useEffect(() => {
        if (session.status !== "finished" || !focusCompletion.current) return;
        focusCompletion.current = false;
        completion.current?.focus();
    }, [session.status]);

    async function requestFinish() {
        if (preparingReview || !databaseLoaded || session.status === "finished") return;
        const request = ++finishRequest.current;
        if (session.status === "running") dispatch({ type: "pause", now: Date.now() });
        setPreparingReview(true);
        setFinishError("");
        finishDialog.current?.showModal();
        try {
            const remaining = await capture.prepareReview();
            if (request !== finishRequest.current) return;
            if (remaining === null) {
                setFinishError("Capture changed while preparing review. Keep the session open and try again.");
            } else if (remaining === 0) {
                finishSession();
            }
        } catch (error) {
            if (request === finishRequest.current) setFinishError(`Could not finish reading drops: ${String(error)}`);
        } finally {
            if (request === finishRequest.current) setPreparingReview(false);
        }
    }

    function keepSessionOpen() {
        finishRequest.current += 1;
        if (preparingReview) capture.stopCapture();
        setPreparingReview(false);
        finishDialog.current?.close();
    }

    return (
        <>
            <header className={styles.DeskHeader}>
                <h1 className="sr-only">Grind desk</h1>
                <GrindSpotPicker
                    spot={spot}
                    region={session.region}
                    locked={!spotEditable}
                    disabled={!spotEditable || !databaseLoaded || market.fetchingPrices || !visible}
                    onSelect={changeGrindSpot}
                    preferences={spotPreferences}
                    onPreferencesChange={onSpotPreferencesChange}
                />
                <button
                    type="button"
                    className="button subtle"
                    disabled={!databaseLoaded || !overlay.available}
                    title={
                        overlay.available
                            ? "Open a draggable, always-on-top session window"
                            : "Available in the desktop app"
                    }
                    onClick={overlay.openOverlay}
                >
                    <Icon name="popout" size={15} />
                    Pop out session
                </button>
            </header>
            {overlay.error && (
                <div className={styles.OverlayError}>
                    <Feedback tone="error">{overlay.error}</Feedback>
                </div>
            )}
            <SessionMetrics
                controller={controller}
                saved={saved}
                visible={visible}
                onFinish={() => void requestFinish()}
            />
            <FinishReviewDialog
                dialogRef={finishDialog}
                preparing={preparingReview}
                error={finishError}
                unresolvedCount={unresolvedCount}
                canFinish={databaseLoaded}
                onKeepOpen={keepSessionOpen}
                onReview={() => {
                    keepSessionOpen();
                    focusLootReview();
                }}
                onFinish={finishSession}
            />
            {session.status === "finished" && (
                <section ref={completion} className={styles.Completion} aria-label="Session complete" tabIndex={-1}>
                    <div>
                        <strong>Session complete</strong>
                        <span>Review this session in History, or start a new one when you are ready.</span>
                    </div>
                    <button className="button" type="button" onClick={onOpenHistory}>
                        View history
                    </button>
                </section>
            )}
            <LiveLootCapture controller={capture} />
            <LootLedger
                key={session.id}
                title="Drops"
                mode={dropView}
                switcher={
                    <fieldset className="segmented">
                        <legend className="sr-only">Drop view</legend>
                        {(["inventory", "ledger"] as const).map((mode) => (
                            <button
                                key={mode}
                                type="button"
                                aria-pressed={dropView === mode}
                                onClick={() => setDropView(mode)}
                            >
                                {mode === "inventory" ? "Inventory" : "Ledger"}
                            </button>
                        ))}
                    </fieldset>
                }
                tools={<SessionTools controller={controller} visible={visible} />}
                loading={!databaseLoaded}
                session={session}
                visible={visible}
                editingDisabled={editingDisabled}
                onRemove={(id) => dispatch({ type: "remove-entry", id })}
                onUpdate={(id, quantity, unitPrice) => dispatch({ type: "update-entry", id, quantity, unitPrice })}
            />
        </>
    );
}
