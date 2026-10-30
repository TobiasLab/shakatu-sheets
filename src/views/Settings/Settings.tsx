import { useEffect } from "react";
import type { Theme } from "../../api/preferences";
import { ConsumablePresetSettings } from "../../components/ConsumablePresets/ConsumablePresetSettings";
import { Feedback } from "../../components/Feedback/Feedback";
import { FormField } from "../../components/FormField/FormField";
import { GrindSpotPicker } from "../../components/GrindSpotPicker/GrindSpotPicker";
import type { SpotPreferences } from "../../components/GrindSpotPicker/preferences";
import type { SessionState } from "../../domain/session";
import { formatTimestamp } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import type { PersistedSetting } from "../../hooks/usePersistedSetting";
import type { useSelfImprovement } from "../../hooks/useSelfImprovement";
import { isLootFont, type LootFont } from "../../recognition/lootFont";
import { GarmothConnectionSettings } from "./GarmothConnectionSettings";
import { SelfImprovementSettings } from "./SelfImprovementSettings";
import styles from "./Settings.module.css";

// After a failed load, Retry reloads instead of saving the unconfirmed default over the stored value.
function SettingError({ setting }: { setting: Pick<PersistedSetting<unknown>, "error" | "failedTo" | "retry"> }) {
    if (!setting.error) return null;
    return (
        <div role="alert" className={styles.Error}>
            {setting.error}
            <button type="button" className="button" onClick={setting.retry}>
                {setting.failedTo === "load" ? "Retry loading" : "Retry save"}
            </button>
        </div>
    );
}

export function SettingsView({
    marketController,
    theme,
    spotPreferences,
    onOpenCapture,
    overlayOpacity,
    lootFont,
    debugRoiSamples,
    selfImprovement,
    showSelfImprovement = false,
}: {
    marketController: Pick<
        LiveSessionController,
        | "session"
        | "spot"
        | "market"
        | "marketItemIds"
        | "databaseLoaded"
        | "editingDisabled"
        | "changeRegion"
        | "spotEditable"
        | "changeGrindSpot"
    >;
    theme: PersistedSetting<Theme>;
    spotPreferences: PersistedSetting<SpotPreferences>;
    onOpenCapture: () => void;
    overlayOpacity: PersistedSetting<number> | null;
    lootFont: PersistedSetting<LootFont>;
    /** Development builds only. */
    debugRoiSamples: PersistedSetting<boolean> | null;
    selfImprovement: ReturnType<typeof useSelfImprovement>;
    showSelfImprovement?: boolean;
}) {
    const {
        session,
        spot,
        market,
        marketItemIds,
        databaseLoaded,
        editingDisabled,
        changeRegion,
        spotEditable,
        changeGrindSpot,
    } = marketController;
    useEffect(() => {
        if (showSelfImprovement) {
            document.getElementById("self-improvement")?.scrollIntoView({ block: "start" });
            document.getElementById("self-improvement-title")?.focus({ preventScroll: true });
        }
    }, [showSelfImprovement]);
    return (
        <>
            <header className="topbar">
                <div>
                    <h1>Settings</h1>
                </div>
            </header>

            <div className={styles.Layout}>
                <nav className={styles.SectionNavigation} aria-label="Settings sections">
                    <a href="#market">Market</a>
                    <a href="#appearance">Appearance</a>
                    <a href="#capture-preferences">Capture</a>
                    <a href="#self-improvement">Self-improvement</a>
                    <a href="#integrations">Integrations</a>
                    <a href="#consumables">Consumable presets</a>
                </nav>
                <div className={styles.Content}>
                    <div className={styles.Preferences}>
                        <section id="market" className="panel" aria-labelledby="market-title">
                            <div className="panel-heading">
                                <h2 id="market-title">Market</h2>
                            </div>
                            <div className={styles.SettingsForm}>
                                <FormField label="Region">
                                    <select
                                        aria-label="Region"
                                        value={session.region}
                                        disabled={editingDisabled || market.fetchingPrices}
                                        onChange={(event) => changeRegion(event.target.value as SessionState["region"])}
                                        aria-describedby={session.status === "finished" ? "region-locked" : undefined}
                                    >
                                        <option value="eu">EU</option>
                                        <option value="na">NA</option>
                                    </select>
                                </FormField>
                                {session.status === "finished" && (
                                    <p id="region-locked">Start a new session to change region.</p>
                                )}
                                <div className={styles.MarketHeading}>
                                    <h3>Market prices for {spot.name}</h3>
                                    <GrindSpotPicker
                                        compact
                                        spot={spot}
                                        region={session.region}
                                        disabled={!spotEditable || !databaseLoaded || market.fetchingPrices}
                                        onSelect={changeGrindSpot}
                                        spotPreferences={spotPreferences}
                                    />
                                </div>
                                {!spotEditable && <p>Grind spot locked for this session.</p>}
                                <div className={styles.MarketDetails} aria-live="polite">
                                    <div>
                                        <p className="eyebrow">Prices from Arsha</p>
                                        {market.marketPrices === null ? (
                                            <strong>Reading saved {session.region.toUpperCase()} prices...</strong>
                                        ) : market.currentMarketPrices.length === 0 ? (
                                            <>
                                                <strong>No {session.region.toUpperCase()} prices saved</strong>
                                                <span>Fetch once from Arsha, or continue with manual unit prices.</span>
                                            </>
                                        ) : market.usingFallbackPrices ? (
                                            <>
                                                <strong>
                                                    Using {market.marketPriceRegion?.toUpperCase()} prices from{" "}
                                                    {formatTimestamp(market.lastPriceFetch)}
                                                </strong>
                                                <span>
                                                    No {session.region.toUpperCase()} snapshot is saved.{" "}
                                                    {market.currentMarketPrices.length} of {marketItemIds.length}{" "}
                                                    {market.marketPriceRegion?.toUpperCase()} profile items are used as
                                                    fallback.
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <strong>
                                                    {session.region.toUpperCase()} prices from{" "}
                                                    {formatTimestamp(market.lastPriceFetch)}
                                                </strong>
                                                <span>
                                                    {market.currentMarketPrices.length} of {marketItemIds.length}{" "}
                                                    profile items saved locally.
                                                </span>
                                            </>
                                        )}
                                        {market.marketError && <Feedback tone="error">{market.marketError}</Feedback>}
                                    </div>
                                    <button
                                        className="button"
                                        type="button"
                                        disabled={
                                            !databaseLoaded || market.fetchingPrices || market.marketPrices === null
                                        }
                                        onClick={market.fetchMarketPrices}
                                    >
                                        {market.fetchingPrices
                                            ? "Fetching..."
                                            : market.marketPriceRegion !== session.region
                                              ? `Fetch ${session.region.toUpperCase()} prices`
                                              : "Refresh prices"}
                                    </button>
                                </div>
                            </div>
                        </section>

                        <section id="appearance" className="panel" aria-labelledby="appearance-title">
                            <div className="panel-heading">
                                <div>
                                    <h2 id="appearance-title">Appearance</h2>
                                </div>
                            </div>
                            <div className={styles.SettingsForm}>
                                <fieldset className={styles.ThemePicker}>
                                    <legend>Theme</legend>
                                    {(
                                        [
                                            { id: "dark", label: "Dark" },
                                            { id: "light", label: "Light" },
                                        ] as const
                                    ).map(({ id, label }) => (
                                        <label key={id} className={`${styles.ThemeOption} ${styles[id] ?? ""}`}>
                                            <input
                                                type="radio"
                                                name="theme"
                                                value={id}
                                                checked={theme.value === id}
                                                onChange={() => theme.update(id)}
                                            />
                                            <span className={styles.ThemePreview} aria-hidden="true">
                                                <i />
                                                <span>
                                                    <b />
                                                    <b />
                                                    <b />
                                                </span>
                                            </span>
                                            <span>{label}</span>
                                        </label>
                                    ))}
                                </fieldset>
                                <SettingError setting={theme} />
                                {overlayOpacity && (
                                    <>
                                        <label htmlFor="overlay-opacity">Overlay opacity</label>
                                        <div className={styles.OpacitySlider}>
                                            <input
                                                id="overlay-opacity"
                                                type="range"
                                                min="25"
                                                max="100"
                                                step="5"
                                                value={overlayOpacity.value}
                                                disabled={!overlayOpacity.loaded}
                                                onChange={(event) => overlayOpacity.update(event.target.valueAsNumber)}
                                            />
                                            <output htmlFor="overlay-opacity">{overlayOpacity.value}%</output>
                                        </div>
                                        {overlayOpacity.saving && <p role="status">Saving opacity…</p>}
                                        <SettingError setting={overlayOpacity} />
                                    </>
                                )}
                            </div>
                        </section>
                        <section id="capture-preferences" className="panel" aria-labelledby="capture-preferences-title">
                            <div className="panel-heading">
                                <div>
                                    <h2 id="capture-preferences-title">Capture</h2>
                                </div>
                            </div>
                            <div className={styles.SettingsForm}>
                                <FormField label="In-game font">
                                    <select
                                        id="loot-font"
                                        value={lootFont.value}
                                        disabled={!lootFont.loaded && !lootFont.error}
                                        aria-describedby="loot-font-description"
                                        onChange={(event) => {
                                            if (isLootFont(event.target.value))
                                                void lootFont.update(event.target.value);
                                        }}
                                    >
                                        <option value="korean">Korean Font</option>
                                        <option value="strong-sword">Strong Sword</option>
                                    </select>
                                </FormField>
                                <p id="loot-font-description">
                                    Applies when capture next starts.
                                    {lootFont.saving && " Saving…"}
                                </p>
                                <SettingError setting={lootFont} />
                                <button type="button" className="button" onClick={onOpenCapture}>
                                    Go to capture setup
                                </button>
                                <details className={styles.Diagnostics}>
                                    <summary>Privacy & capture details</summary>
                                    <p>
                                        Capture pixels stay in memory and are never uploaded. Self-improvement, when
                                        enabled, stores small item-name and quantity crops from your Needs attention
                                        corrections on this device; examples stay until deleted or replaced by newer
                                        examples. Automatic placement scans only the highlighted search area. Confirmed
                                        loot crops are processed by the bundled local OCR worker and recognized results
                                        are added automatically. Otherwise only final coordinates, rare-area
                                        confirmation, source dimensions, and BDO UI scale are stored.
                                    </p>
                                </details>
                                {debugRoiSamples && (
                                    <div className={styles.DeveloperOptions}>
                                        <p className="eyebrow">Developer</p>
                                        <label className={styles.Option}>
                                            <span>
                                                <strong>Record ROI samples while the session timer runs</strong>
                                                <small>
                                                    Saves the normal and rare loot crops to{" "}
                                                    <code>dev-samples/live-loot/</code> in this repository, one folder
                                                    for each stretch of running timer. Roughly 10 GB per hour. Never
                                                    uploaded.
                                                </small>
                                            </span>
                                            <input
                                                id="debug-roi-samples"
                                                type="checkbox"
                                                role="switch"
                                                checked={debugRoiSamples.value}
                                                aria-checked={debugRoiSamples.value}
                                                disabled={!debugRoiSamples.loaded}
                                                onChange={(event) => debugRoiSamples.update(event.target.checked)}
                                            />
                                        </label>
                                        <SettingError setting={debugRoiSamples} />
                                    </div>
                                )}
                            </div>
                        </section>
                        <SelfImprovementSettings learning={selfImprovement} />
                    </div>
                    <h2 id="integrations" className={styles.SectionTitle}>
                        Integrations <span>Optional</span>
                    </h2>
                    <div className={styles.SettingsGrid}>
                        <GarmothConnectionSettings />
                        <section
                            id="consumables"
                            className={`panel ${styles.ConsumablesSection}`}
                            aria-labelledby="consumables-settings-title"
                        >
                            <div className="panel-heading">
                                <h2 id="consumables-settings-title">Consumable presets</h2>
                            </div>
                            <ConsumablePresetSettings initialRegion={session.region} disabled={!databaseLoaded} />
                        </section>
                    </div>
                </div>
            </div>
        </>
    );
}
