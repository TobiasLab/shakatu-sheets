import type { LootAlignmentGuide, LootUiScale } from "../../recognition/displayCapture";
import styles from "./LiveLootCapture.module.css";
import { type LiveLootCaptureProps, useLiveLootCapture } from "./useLiveLootCapture";

type SourceDimensions = { width: number; height: number };
function AlignmentGuide({ frameSize, guide }: { frameSize: SourceDimensions; guide: LootAlignmentGuide }) {
    return (
        <div
            className={styles.RecognitionGuide}
            aria-hidden="true"
            style={{
                left: `${(guide.x / frameSize.width) * 100}%`,
                top: `${(guide.y / frameSize.height) * 100}%`,
                width: `${(guide.width / frameSize.width) * 100}%`,
                height: `${(guide.height / frameSize.height) * 100}%`,
            }}
        >
            <span className={styles.GuideLabel}>
                {guide.rowCenters.length === 1 ? "Item-name center" : "Item-name rows"}
            </span>
            {guide.rowCenters.map((center) => (
                <i
                    key={center}
                    style={{
                        top: `${((center - guide.y) / guide.height) * 100}%`,
                    }}
                />
            ))}
        </div>
    );
}
export function LiveLootCapture(props: LiveLootCaptureProps) {
    const {
        setupButton,
        setupOpen,
        diagnosticsOpen,
        setDiagnosticsOpen,
        video,
        status,
        previewToggleBusy,
        togglePreviews,
        previewsEnabled,
        stopCapture,
        captureAllowed,
        captureBackend,
        sourceWaiting,
        startCapture,
        databaseLoaded,
        sessionStatus,
        error,
        previewToggleError,
        recognitionError,
        previewsEnabledRef,
        savingRegion,
        draggingRegion,
        placementModeRef,
        activeRegionKindRef,
        updateCaptureRegion,
        moveRegion,
        normalRegionRef,
        rareRegionRef,
        canvas,
        sourceSupported,
        placementMode,
        searchRegion,
        activeRegionKind,
        normalRegion,
        normalGuideFrameSize,
        normalAlignmentGuide,
        rareRegion,
        rareRecognitionReady,
        rareGuideFrameSize,
        rareAlignmentGuide,
        sourceDimensions,
        selectRegionKind,
        calibrationInstruction,
        beginManualPlacement,
        resetSelectedRegion,
        nudgeSelectedRegion,
        uiScalePercent,
        changeUiScale,
        calibratedProfile,
        automaticLocalizationAvailable,
        beginAutomaticLocalization,
        regionConfirmed,
        confirmRegion,
        sourceSize,
        sampledFps,
        placementLabel,
        searchRegionPixels,
        normalRegionPixels,
        normalRecognitionReady,
        normalRegionFrameSize,
        rareRegionPixels,
        rareRegionFrameSize,
        recognitionStatus,
        recognitionLabel,
        ocrDiagnostics,
        NORMAL_MAX_OUTSTANDING_OCR_JOBS,
        RARE_MAX_OUTSTANDING_OCR_JOBS,
        formatOcrDuration,
        grindSpotName,
        itemDictionary,
        debugSampleCollectionAvailable,
        sampleCollectionBusy,
        sampleCollectionFinalizing,
        sampleCollectionActive,
        sampleCollectionReady,
        toggleSampleCollection,
        sampleCollection,
        formatSampleCollectionBytes,
        formatSampleCollectionCountdown,
        sampleCollectionNow,
        sampleCollectionError,
        normalRegionCanvas,
        rareRegionCanvas,
        recognitionAnnouncement,
        reviewResults,
        clearReviewResults,
        omittedReviewResults,
        resultDescription,
        acceptReviewResult,
    } = useLiveLootCapture(props);
    return (
        <section
            className={styles.CapturePanel}
            aria-labelledby="live-capture-heading"
            data-setup-open={setupOpen && status === "capturing"}
        >
            <video ref={video} className={styles.SourceVideo} muted playsInline />
            <div className={styles.Intro}>
                <div>
                    <p className="eyebrow">Live recognition</p>
                    <h2 id="live-capture-heading">Automatic loot</h2>
                    <span>
                        {recognitionStatus === "active"
                            ? "Tracking your loot while you play"
                            : recognitionError
                              ? "Recognition needs your attention"
                              : status === "capturing"
                                ? sourceSupported
                                    ? "Confirm your loot areas to begin"
                                    : "Preview only · this source has no calibrated OCR profile"
                                : "Bring loot straight into your ledger."}
                    </span>
                </div>
                <div className={styles.Actions}>
                    {status !== "idle" ? (
                        <>
                            {status === "capturing" && (
                                <button
                                    className="button"
                                    type="button"
                                    ref={setupButton}
                                    aria-expanded={setupOpen}
                                    aria-controls="capture-setup"
                                    disabled={previewToggleBusy}
                                    onClick={() => void togglePreviews()}
                                >
                                    {setupOpen ? "Close setup" : "Set up capture"}
                                </button>
                            )}
                            <button className="button" type="button" onClick={stopCapture}>
                                {status === "capturing" ? "Stop capture" : "Cancel request"}
                            </button>
                        </>
                    ) : (
                        <button
                            className="button primary-button"
                            type="button"
                            ref={setupButton}
                            disabled={!captureAllowed}
                            onClick={startCapture}
                        >
                            Choose capture source
                        </button>
                    )}
                </div>
            </div>

            {status === "capturing" && (
                <section className={styles.SetupProgress} aria-label="Capture setup progress">
                    <span>1 · Source selected</span>
                    <span className={!regionConfirmed ? styles.CurrentStep : ""}>2 · Align areas</span>
                    <span className={regionConfirmed ? styles.CurrentStep : ""}>
                        3 · {regionConfirmed ? "Areas confirmed" : "Confirm & track"}
                    </span>
                </section>
            )}
            {!databaseLoaded ? (
                <p className={styles.Note}>Screen capture is available after the active session finishes loading.</p>
            ) : sessionStatus === "idle" ? (
                <p className={styles.Note}>
                    Optional. Choose your game screen, align the two loot areas, then confirm. You can start the timer
                    at any point.
                </p>
            ) : sessionStatus === "paused" ? (
                <p className={styles.Note}>
                    The timer is paused. Capture and local recognition remain available for this session.
                </p>
            ) : sessionStatus === "finished" ? (
                <p className={styles.Note}>Start a new session to choose a capture source.</p>
            ) : null}
            {captureBackend === "windows" && (
                <p className={styles.Note}>
                    Choose an SDR monitor or borderless game window. Align both loot areas after changing sources.
                    Bordered windows and HDR are not supported.
                </p>
            )}
            {status === "requesting" && (
                <p className={styles.Note} role="status">
                    Waiting for the operating-system source picker...
                </p>
            )}
            {sourceWaiting && (
                <p className={styles.Note} role="status">
                    Waiting for the source to update. Restore the game if it is minimized.
                </p>
            )}
            {status === "connecting" && (
                <p className={styles.Note} role="status">
                    Source selected. Waiting for the first video frame...
                </p>
            )}
            {error && (
                <p className={styles.Error} role="alert">
                    {error}
                </p>
            )}
            {previewToggleError && (
                <p className={styles.Error} role="alert">
                    Could not update live previews: {previewToggleError}
                </p>
            )}
            {recognitionError && (
                <p className={styles.Error} role="alert">
                    Local recognition stopped: {recognitionError}
                </p>
            )}
            {status === "capturing" && (
                <div
                    id="capture-setup"
                    hidden={!setupOpen}
                    className={`${styles.CaptureWorkspace} ${previewsEnabled ? "" : styles.PreviewsPaused}`}
                >
                    <div>
                        <div className={styles.Preview}>
                            <div
                                className={styles.PreviewStage}
                                onPointerDown={(event) => {
                                    if (!previewsEnabledRef.current || savingRegion) return;
                                    draggingRegion.current = true;
                                    if (placementModeRef.current !== "localizing") {
                                        updateCaptureRegion(activeRegionKindRef.current, null);
                                    }
                                    event.currentTarget.setPointerCapture(event.pointerId);
                                    moveRegion(event);
                                }}
                                onPointerMove={(event) => {
                                    if (previewsEnabledRef.current && draggingRegion.current) moveRegion(event);
                                }}
                                onPointerUp={(event) => {
                                    if (!draggingRegion.current) return;
                                    draggingRegion.current = false;
                                    const kind = activeRegionKindRef.current;
                                    updateCaptureRegion(
                                        kind,
                                        placementModeRef.current === "localizing"
                                            ? null
                                            : kind === "normal"
                                              ? normalRegionRef.current
                                              : rareRegionRef.current,
                                    );
                                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                        event.currentTarget.releasePointerCapture(event.pointerId);
                                    }
                                }}
                                onPointerCancel={() => {
                                    if (!draggingRegion.current) return;
                                    draggingRegion.current = false;
                                    const kind = activeRegionKindRef.current;
                                    updateCaptureRegion(
                                        kind,
                                        placementModeRef.current === "localizing"
                                            ? null
                                            : kind === "normal"
                                              ? normalRegionRef.current
                                              : rareRegionRef.current,
                                    );
                                }}
                            >
                                <canvas ref={canvas} aria-label="Sampled capture preview" />
                                {sourceSupported && placementMode === "localizing" && searchRegion && (
                                    <div
                                        className={`${styles.RegionOverlay} ${styles.SearchRegionOverlay} ${styles.ActiveRegionOverlay}`}
                                        style={{
                                            left: `${searchRegion.x * 100}%`,
                                            top: `${searchRegion.y * 100}%`,
                                            width: `${searchRegion.width * 100}%`,
                                            height: `${searchRegion.height * 100}%`,
                                        }}
                                    >
                                        <span className={styles.OverlayLabel}>Auto-search area</span>
                                    </div>
                                )}
                                {sourceSupported &&
                                    (placementMode !== "localizing" || activeRegionKind !== "normal") &&
                                    normalRegion && (
                                        <div
                                            className={`${styles.RegionOverlay} ${styles.NormalRegionOverlay} ${
                                                activeRegionKind === "normal" ? styles.ActiveRegionOverlay : ""
                                            }`}
                                            style={{
                                                left: `${normalRegion.x * 100}%`,
                                                top: `${normalRegion.y * 100}%`,
                                                width: `${normalRegion.width * 100}%`,
                                                height: `${normalRegion.height * 100}%`,
                                            }}
                                        >
                                            <span className={styles.OverlayLabel}>Capture envelope</span>
                                            <AlignmentGuide
                                                frameSize={normalGuideFrameSize}
                                                guide={normalAlignmentGuide}
                                            />
                                        </div>
                                    )}
                                {sourceSupported &&
                                    (placementMode !== "localizing" || activeRegionKind !== "rare") &&
                                    rareRegion && (
                                        <div
                                            className={`${styles.RegionOverlay} ${styles.RareRegionOverlay} ${
                                                activeRegionKind === "rare" ? styles.ActiveRegionOverlay : ""
                                            }`}
                                            style={{
                                                left: `${rareRegion.x * 100}%`,
                                                top: `${rareRegion.y * 100}%`,
                                                width: `${rareRegion.width * 100}%`,
                                                height: `${rareRegion.height * 100}%`,
                                            }}
                                        >
                                            <span className={styles.OverlayLabel}>
                                                {rareRecognitionReady ? "Rare recognition area" : "Rare alignment area"}
                                            </span>
                                            <AlignmentGuide frameSize={rareGuideFrameSize} guide={rareAlignmentGuide} />
                                        </div>
                                    )}
                                {!previewsEnabled && (
                                    <div className={styles.PreviewPaused} role="status">
                                        <strong>Live previews paused</strong>
                                        <span>Screen capture continues</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        {sourceDimensions && !sourceSupported ? (
                            <p className={styles.CalibrationError} role="status">
                                Supported sources are 3440 x 1440, 2560 x 1440, and 1920 x 1080.
                            </p>
                        ) : (
                            <fieldset className={styles.CalibrationPanel} disabled={!previewsEnabled}>
                                <fieldset className={styles.AreaSelector}>
                                    <legend>Active area</legend>
                                    <div className={styles.AreaSelectorButtons}>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion || placementMode === "localizing"}
                                            aria-pressed={activeRegionKind === "normal"}
                                            onClick={() => selectRegionKind("normal")}
                                        >
                                            Loot stack
                                        </button>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion || placementMode === "localizing"}
                                            aria-pressed={activeRegionKind === "rare"}
                                            onClick={() => selectRegionKind("rare")}
                                        >
                                            Rare loot
                                        </button>
                                    </div>
                                </fieldset>
                                <p className={styles.CalibrationInstruction}>{calibrationInstruction}</p>
                                {placementMode === "localizing" ? (
                                    <div className={styles.PrecisionControls}>
                                        <span>Automatic placement</span>
                                        <button className="button" type="button" onClick={beginManualPlacement}>
                                            Adjust manually
                                        </button>
                                    </div>
                                ) : (
                                    <div className={styles.PrecisionControls}>
                                        <span>Fine position (1 source pixel)</span>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            onClick={resetSelectedRegion}
                                        >
                                            Reset selected area
                                        </button>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            onClick={() => nudgeSelectedRegion(0, -1)}
                                        >
                                            Up
                                        </button>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            onClick={() => nudgeSelectedRegion(0, 1)}
                                        >
                                            Down
                                        </button>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            onClick={() => nudgeSelectedRegion(-1, 0)}
                                        >
                                            Left
                                        </button>
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={savingRegion}
                                            onClick={() => nudgeSelectedRegion(1, 0)}
                                        >
                                            Right
                                        </button>
                                    </div>
                                )}
                                <div className={styles.CalibrationBar}>
                                    <label className={styles.ScaleControl}>
                                        BDO UI scale
                                        <select
                                            value={uiScalePercent}
                                            disabled={savingRegion}
                                            onChange={(event) =>
                                                changeUiScale(Number(event.currentTarget.value) as LootUiScale)
                                            }
                                        >
                                            <option value={80}>80%</option>
                                            <option value={100}>100%</option>
                                        </select>
                                    </label>
                                    {placementMode !== "localizing" &&
                                        automaticLocalizationAvailable &&
                                        normalRegion && (
                                            <button
                                                className="button"
                                                type="button"
                                                disabled={savingRegion}
                                                onClick={beginAutomaticLocalization}
                                            >
                                                Adjust automatically
                                            </button>
                                        )}
                                    {placementMode !== "localizing" && (
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={!normalRegion || !rareRegion || regionConfirmed || savingRegion}
                                            onClick={confirmRegion}
                                        >
                                            {savingRegion
                                                ? "Saving..."
                                                : regionConfirmed
                                                  ? "Both areas confirmed"
                                                  : placementMode === "aligned"
                                                    ? "Confirm rare area"
                                                    : "Confirm both areas"}
                                        </button>
                                    )}
                                </div>
                            </fieldset>
                        )}
                    </div>
                    <aside className={styles.CaptureSidebar}>
                        <details
                            open={diagnosticsOpen}
                            onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
                        >
                            <summary>Advanced diagnostics</summary>
                            <dl className={styles.Diagnostics}>
                                <div>
                                    <dt>Status</dt>
                                    <dd className={styles.Active}>Capture active</dd>
                                </div>
                                <div>
                                    <dt>Source</dt>
                                    <dd>{sourceSize}</dd>
                                </div>
                                <div>
                                    <dt>Sampled rate</dt>
                                    <dd className={sampledFps >= 5 ? styles.Active : styles.Warning}>
                                        {sampledFps > 0 ? `${sampledFps.toFixed(1)} FPS` : "Measuring..."}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Placement</dt>
                                    <dd className={placementMode === "aligned" ? styles.Active : styles.Warning}>
                                        {placementLabel}
                                    </dd>
                                </div>
                                {placementMode === "localizing" && (
                                    <div>
                                        <dt>Auto-search area</dt>
                                        <dd>
                                            {searchRegionPixels
                                                ? `${searchRegionPixels.x}, ${searchRegionPixels.y} at ${searchRegionPixels.width} x ${searchRegionPixels.height}`
                                                : "Waiting for search area..."}
                                        </dd>
                                    </div>
                                )}
                                <div>
                                    <dt>Loot stack area</dt>
                                    <dd>
                                        {normalRegionPixels
                                            ? `${normalRegionPixels.x}, ${normalRegionPixels.y} at ${normalRegionPixels.width} x ${normalRegionPixels.height}`
                                            : "Unavailable"}
                                    </dd>
                                </div>
                                <div>
                                    <dt>{normalRecognitionReady ? "Recognition crop" : "Normal crop"}</dt>
                                    <dd className={normalRegionFrameSize ? styles.Active : styles.Warning}>
                                        {normalRegionFrameSize
                                            ? `${normalRegionFrameSize.width} x ${normalRegionFrameSize.height}`
                                            : placementMode === "localizing"
                                              ? "Waiting for automatic alignment..."
                                              : normalRegionPixels
                                                ? "Waiting for pixels..."
                                                : "Unavailable"}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Rare loot area</dt>
                                    <dd>
                                        {rareRegionPixels
                                            ? `${rareRegionPixels.x}, ${rareRegionPixels.y} at ${rareRegionPixels.width} x ${rareRegionPixels.height}`
                                            : "Unavailable"}
                                    </dd>
                                </div>
                                <div>
                                    <dt>{rareRecognitionReady ? "Rare recognition crop" : "Rare crop"}</dt>
                                    <dd className={rareRegionFrameSize ? styles.Active : styles.Warning}>
                                        {rareRegionFrameSize
                                            ? `${rareRegionFrameSize.width} x ${rareRegionFrameSize.height}`
                                            : rareRegionPixels
                                              ? "Waiting for pixels..."
                                              : "Unavailable"}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Recognition</dt>
                                    <dd className={recognitionStatus === "active" ? styles.Active : styles.Warning}>
                                        {recognitionLabel}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Normal OCR jobs</dt>
                                    <dd
                                        className={
                                            ocrDiagnostics.normal.outstandingJobs < NORMAL_MAX_OUTSTANDING_OCR_JOBS
                                                ? styles.Active
                                                : styles.Warning
                                        }
                                    >
                                        {ocrDiagnostics.normal.outstandingJobs} / {NORMAL_MAX_OUTSTANDING_OCR_JOBS}{" "}
                                        outstanding, peak {ocrDiagnostics.normal.peakOutstandingJobs}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Rare OCR jobs</dt>
                                    <dd
                                        className={
                                            ocrDiagnostics.rare.outstandingJobs < RARE_MAX_OUTSTANDING_OCR_JOBS
                                                ? styles.Active
                                                : styles.Warning
                                        }
                                    >
                                        {ocrDiagnostics.rare.outstandingJobs} / {RARE_MAX_OUTSTANDING_OCR_JOBS}{" "}
                                        outstanding, peak {ocrDiagnostics.rare.peakOutstandingJobs}
                                    </dd>
                                </div>
                                <div>
                                    <dt>OCR worker job time</dt>
                                    <dd>{formatOcrDuration(ocrDiagnostics.worker)}</dd>
                                </div>
                                <div>
                                    <dt>Frame analysis</dt>
                                    <dd>
                                        {ocrDiagnostics.analysis.completedJobs === 0
                                            ? "Waiting…"
                                            : `${(ocrDiagnostics.analysis.totalDurationMs / ocrDiagnostics.analysis.completedJobs).toFixed(2)} ms average (${ocrDiagnostics.analysis.completedJobs} frames)`}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Item profile</dt>
                                    <dd>
                                        {grindSpotName} ({itemDictionary.length})
                                    </dd>
                                </div>
                            </dl>
                            {debugSampleCollectionAvailable && (
                                <div className={styles.DevSampleCollector}>
                                    <p className="eyebrow">Development only</p>
                                    <strong>ROI sample collection</strong>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={
                                            sampleCollectionBusy ||
                                            sampleCollectionFinalizing ||
                                            (!sampleCollectionActive && !sampleCollectionReady)
                                        }
                                        onClick={() => void toggleSampleCollection()}
                                    >
                                        {sampleCollectionBusy
                                            ? "Updating sample collection..."
                                            : sampleCollectionFinalizing
                                              ? "Finishing ROI samples..."
                                              : sampleCollectionActive
                                                ? "Stop saving ROI samples"
                                                : "Save ROI samples for 30 minutes"}
                                    </button>
                                    {!sampleCollectionReady &&
                                        !sampleCollectionActive &&
                                        !sampleCollectionFinalizing && (
                                            <small>Confirm both capture areas before collecting samples.</small>
                                        )}
                                    {sampleCollection && sampleCollection.phase !== "idle" && (
                                        <small>
                                            {sampleCollection.writtenBatchCount * 2} PNGs,{" "}
                                            {formatSampleCollectionBytes(sampleCollection.bytesWritten)}
                                            {sampleCollection.droppedBatchCount > 0
                                                ? `, ${sampleCollection.droppedBatchCount} dropped pairs`
                                                : ""}
                                        </small>
                                    )}
                                    {sampleCollectionActive && (
                                        <small aria-hidden="true">
                                            Time remaining:{" "}
                                            {formatSampleCollectionCountdown(
                                                sampleCollection?.deadlineAtUnixMs ?? null,
                                                sampleCollectionNow,
                                            )}
                                        </small>
                                    )}
                                    {sampleCollection?.phase === "finished" && (
                                        <small role="status">ROI sample collection finished.</small>
                                    )}
                                    {sampleCollection?.path && <code>{sampleCollection.path}</code>}
                                    {(sampleCollectionError || sampleCollection?.error) && (
                                        <small className={styles.DevSampleError} role="alert">
                                            {sampleCollectionError || sampleCollection?.error}
                                        </small>
                                    )}
                                </div>
                            )}
                        </details>
                        <div className={styles.RegionPreview}>
                            <span>{normalRecognitionReady ? "Normal recognition preview" : "Normal preview"}</span>
                            <div className={styles.RegionPreviewStage}>
                                <canvas
                                    ref={normalRegionCanvas}
                                    aria-label={
                                        normalRecognitionReady ? "Loot stack recognition crop" : "Loot stack preview"
                                    }
                                />
                                {placementMode !== "localizing" && normalRegionFrameSize && (
                                    <AlignmentGuide frameSize={normalGuideFrameSize} guide={normalAlignmentGuide} />
                                )}
                            </div>
                        </div>
                        <div className={`${styles.RegionPreview} ${styles.RareRegionPreview}`}>
                            <span>{rareRecognitionReady ? "Rare recognition preview" : "Rare preview"}</span>
                            <div className={styles.RegionPreviewStage}>
                                <canvas
                                    ref={rareRegionCanvas}
                                    aria-label={
                                        rareRecognitionReady ? "Rare recognition crop" : "Rare alignment preview"
                                    }
                                />
                                {rareRegionFrameSize && (
                                    <AlignmentGuide frameSize={rareGuideFrameSize} guide={rareAlignmentGuide} />
                                )}
                            </div>
                            <p>
                                {!calibratedProfile
                                    ? "Preview only - no calibrated recognition profile"
                                    : rareRecognitionReady
                                      ? "Provisional recognition - recognized banners are added automatically"
                                      : "Align and confirm the rare area to enable provisional recognition"}
                            </p>
                        </div>
                    </aside>
                </div>
            )}
            <div className={styles.RecognitionAnnouncements} aria-live="polite" aria-atomic="true">
                {recognitionAnnouncement}
            </div>
            {reviewResults.some((entry) => !entry.accepted) && (
                <div className={styles.ReviewFeed}>
                    <div className={styles.ReviewHeader}>
                        <div>
                            <p className="eyebrow">Local OCR review</p>
                            <h3>
                                Needs attention <span>({reviewResults.filter((entry) => !entry.accepted).length})</span>
                            </h3>
                        </div>
                        <button className="button subtle" type="button" onClick={clearReviewResults}>
                            Clear
                        </button>
                    </div>
                    {omittedReviewResults > 0 && (
                        <p className={styles.FeedWarning} role="status">
                            {`${omittedReviewResults} older ${omittedReviewResults === 1 ? "result was" : "results were"} omitted from this bounded review feed.`}
                        </p>
                    )}
                    <ul>
                        {reviewResults
                            .filter((entry) => !entry.accepted)
                            .map((review) => (
                                <li key={review.id}>
                                    <div>
                                        <span className={`${styles.ResultStatus} ${styles[review.result.status]}`}>
                                            {review.source === "normal" ? "Normal loot" : "Rare banner"} ·{" "}
                                            {review.result.status === "recognized"
                                                ? "Ready to add"
                                                : review.result.status === "withheld"
                                                  ? "Needs review"
                                                  : review.result.status === "dropped"
                                                    ? "Not processed"
                                                    : "Could not read"}
                                        </span>
                                        <strong>{resultDescription(review.result)}</strong>
                                        {review.error && <small className={styles.ResultError}>{review.error}</small>}
                                    </div>
                                    {review.result.status === "recognized" && !review.accepted && (
                                        <button
                                            className="button"
                                            type="button"
                                            disabled={sessionStatus === "finished"}
                                            onClick={() => acceptReviewResult(review.id)}
                                        >
                                            Retry add
                                        </button>
                                    )}
                                </li>
                            ))}
                    </ul>
                    <p>
                        These results have not been added. Use Retry add for recognized loot, or Add loot or expense to
                        enter a correction. Clear dismisses this review list; it does not remove ledger entries.
                    </p>
                </div>
            )}
            <details className={styles.PrivacyNote}>
                <summary>Privacy & capture details</summary>
                <p>
                    During normal operation, capture pixels stay in memory and are never saved or uploaded.{" "}
                    {debugSampleCollectionAvailable &&
                        "The explicit development sample action saves only the configured normal and rare crops locally until they are deleted; it never saves the full screen or uploads samples. "}
                    Automatic placement scans only the highlighted search area. Confirmed loot crops are processed by
                    the bundled local OCR worker and recognized results are added automatically.{" "}
                    {debugSampleCollectionAvailable
                        ? "Outside development sample runs, only final coordinates, rare-area confirmation, source dimensions, and BDO UI scale are stored."
                        : "Only final coordinates, rare-area confirmation, source dimensions, and BDO UI scale are stored."}
                </p>
            </details>
        </section>
    );
}
