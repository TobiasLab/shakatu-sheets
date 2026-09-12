import { type FormEvent, useEffect, useState } from "react";
import {
    fetchGarmothCharacters,
    type GarmothSettings,
    loadGarmothSettings,
    saveGarmothApiKey,
    selectGarmothCharacter,
} from "../../api/tauri";
import type { SessionState } from "../../domain/session";
import { formatTimestamp } from "../../format";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import type { useLootFont } from "../../hooks/useLootFont";
import type { useOverlayOpacity } from "../../hooks/useOverlayOpacity";
import type { Theme } from "../../hooks/useTheme";
import { isLootFont } from "../../recognition/lootFont";
import styles from "./Settings.module.css";

export function SettingsView({
    marketController,
    theme,
    onThemeChange,
    onOpenCapture,
    overlayOpacity,
    lootFont,
}: {
    marketController: Pick<
        LiveSessionController,
        "session" | "market" | "marketItemIds" | "databaseLoaded" | "editingDisabled" | "changeRegion"
    >;
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    onOpenCapture: () => void;
    overlayOpacity: ReturnType<typeof useOverlayOpacity>;
    lootFont: ReturnType<typeof useLootFont>;
}) {
    const { session, market, marketItemIds, databaseLoaded, editingDisabled, changeRegion } = marketController;
    const [settings, setSettings] = useState<GarmothSettings | null>(null);
    const [characterIds, setCharacterIds] = useState("");
    const [selectedCharacterId, setSelectedCharacterId] = useState("");
    const [busy, setBusy] = useState<"key" | "characters" | "selection" | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    async function reloadSettings() {
        const loaded = await loadGarmothSettings();
        setSettings(loaded);
        setCharacterIds(loaded.characterIds.join(", "));
        setSelectedCharacterId(loaded.selectedCharacterId?.toString() ?? "");
    }

    useEffect(() => {
        reloadSettings().catch((failure) => setError(String(failure)));
    }, []);

    async function saveApiKey(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy("key");
        setError("");
        setMessage("");
        const form = event.currentTarget;
        const apiKey = String(new FormData(form).get("apiKey") ?? "");
        try {
            await saveGarmothApiKey(apiKey);
            form.reset();
            await reloadSettings();
            setMessage("API key validated and saved locally. Fetch your character builds next.");
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(null);
        }
    }

    async function fetchCharacters() {
        setBusy("characters");
        setError("");
        setMessage("");
        try {
            await fetchGarmothCharacters(characterIds);
            await reloadSettings();
            setMessage("Character builds fetched. Choose the character to use for uploads.");
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(null);
        }
    }

    async function saveCharacterSelection() {
        setBusy("selection");
        setError("");
        setMessage("");
        try {
            await selectGarmothCharacter(selectedCharacterId);
            await reloadSettings();
            setMessage("Upload character saved.");
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(null);
        }
    }

    return (
        <>
            <header className="topbar">
                <div>
                    <h1>Settings</h1>
                    <p className="page-description">Market, appearance, capture, and the services you connect.</p>
                </div>
            </header>

            <nav className={styles.SectionNavigation} aria-label="Settings sections">
                <a href="#market">Market</a>
                <a href="#appearance">Appearance</a>
                <a href="#capture-preferences">Capture</a>
                <a href="#integrations">Integrations</a>
            </nav>
            <div className={styles.Preferences}>
                <section id="market" className="panel" aria-labelledby="market-title">
                    <div className="panel-heading">
                        <h2 id="market-title">Market</h2>
                    </div>
                    <div className={styles.SettingsForm}>
                        <label>
                            Region
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
                        </label>
                        {session.status === "finished" && (
                            <p id="region-locked">Start a new session to change region.</p>
                        )}
                        <h3>Market prices</h3>
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
                                            {market.currentMarketPrices.length} of {marketItemIds.length} profile items
                                            saved locally.
                                        </span>
                                    </>
                                )}
                                {market.marketError && <span className={styles.Error}>{market.marketError}</span>}
                            </div>
                            <button
                                className="button"
                                type="button"
                                disabled={!databaseLoaded || market.fetchingPrices || market.marketPrices === null}
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

                <section id="appearance" className="panel">
                    <div className="panel-heading">
                        <div>
                            <h2>Appearance</h2>
                        </div>
                    </div>
                    <div className={styles.SettingsForm}>
                        <fieldset className={styles.ThemePicker}>
                            <legend>Theme</legend>
                            {(
                                [
                                    { id: "dark", label: "Dark" },
                                    { id: "moss", label: "Moss" },
                                    { id: "light", label: "Light" },
                                ] as const
                            ).map(({ id, label }) => (
                                <label key={id} className={`${styles.ThemeOption} ${styles[id] ?? ""}`}>
                                    <input
                                        type="radio"
                                        name="theme"
                                        value={id}
                                        checked={theme === id}
                                        onChange={() => onThemeChange(id)}
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
                        <p>Saved automatically. Your choice applies throughout the app.</p>
                        <label htmlFor="overlay-opacity">Overlay opacity</label>
                        <div className={styles.OpacitySlider}>
                            <input
                                id="overlay-opacity"
                                type="range"
                                min="25"
                                max="100"
                                step="5"
                                value={overlayOpacity.opacity}
                                disabled={!overlayOpacity.loaded}
                                aria-describedby="overlay-opacity-description"
                                onChange={(event) => overlayOpacity.updateOpacity(event.target.valueAsNumber)}
                            />
                            <output htmlFor="overlay-opacity">{overlayOpacity.opacity}%</output>
                        </div>
                        <p id="overlay-opacity-description">
                            Fades the entire overlay. Changes apply immediately and are saved automatically.
                            {overlayOpacity.saving && " Saving…"}
                        </p>
                        {overlayOpacity.error && (
                            <div role="alert" className={styles.Error}>
                                {overlayOpacity.error}
                                <button
                                    type="button"
                                    className="button"
                                    onClick={() => overlayOpacity.updateOpacity(overlayOpacity.opacity)}
                                >
                                    Retry save
                                </button>
                            </div>
                        )}
                    </div>
                </section>
                <section id="capture-preferences" className="panel">
                    <div className="panel-heading">
                        <div>
                            <h2>Capture</h2>
                        </div>
                    </div>
                    <div className={styles.SettingsForm}>
                        <p>
                            Tracking continues while you browse or minimize. Live previews run only when setup is open
                            and visible.
                        </p>
                        <label htmlFor="loot-font">In-game font</label>
                        <select
                            id="loot-font"
                            value={lootFont.font}
                            disabled={!lootFont.loaded && !lootFont.error}
                            aria-describedby="loot-font-description"
                            onChange={(event) => {
                                if (isLootFont(event.target.value)) void lootFont.updateFont(event.target.value);
                            }}
                        >
                            <option value="korean">Korean Font</option>
                            <option value="strong-sword">Strong Sword</option>
                        </select>
                        <p id="loot-font-description">
                            Match the font selected in the game. Applies when capture next starts.
                            {lootFont.saving && " Saving…"}
                        </p>
                        {lootFont.error && (
                            <div role="alert" className={styles.Error}>
                                {lootFont.error}
                                <button
                                    type="button"
                                    className="button"
                                    onClick={() => void lootFont.updateFont(lootFont.font)}
                                >
                                    Save selected font
                                </button>
                            </div>
                        )}
                        <button type="button" className="button" onClick={onOpenCapture}>
                            Go to capture setup
                        </button>
                    </div>
                </section>
            </div>
            <h2 id="integrations" className={styles.SectionTitle}>
                Integrations <span>Optional</span>
            </h2>
            <p className={styles.SectionNote}>Connect your account to publish finished sessions when you choose.</p>
            <div className={styles.SettingsGrid}>
                <section className="panel">
                    <div className="panel-heading">
                        <div>
                            <h2>Garmoth</h2>
                        </div>
                        <span>
                            {settings?.apiKeyConfigured
                                ? "Configured"
                                : settings === null && !error
                                  ? "Loading..."
                                  : "Not configured"}
                        </span>
                    </div>
                    <form className={styles.SettingsForm} onSubmit={saveApiKey}>
                        <label>
                            API key
                            <input
                                name="apiKey"
                                disabled={busy !== null}
                                type="password"
                                required
                                maxLength={512}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={settings?.apiKeyConfigured ? "Enter a replacement key" : "Garmoth API key"}
                            />
                        </label>
                        <p>
                            Your key stays on this device and is used only to connect to Garmoth. It is never displayed
                            again.
                        </p>
                        <button className="button primary-button" type="submit" disabled={busy !== null}>
                            {busy === "key" ? "Validating..." : "Validate and save key"}
                        </button>
                    </form>
                </section>

                <section className="panel">
                    <div className="panel-heading">
                        <div>
                            <h2>Character build</h2>
                        </div>
                    </div>
                    <div className={styles.SettingsForm}>
                        {!settings?.apiKeyConfigured && (
                            <p className={styles.SetupHint}>Connect your API key first to enable character setup.</p>
                        )}
                        <label>
                            Gear Planner character IDs
                            <input
                                value={characterIds}
                                disabled={!settings?.apiKeyConfigured || busy !== null}
                                onChange={(event) => setCharacterIds(event.target.value)}
                                placeholder="dNTbRAtHn1"
                            />
                        </label>
                        <p>
                            Enter the final part of each Garmoth character URL, such as <code>dNTbRAtHn1</code>. You can
                            provide up to 20 comma-separated IDs.
                        </p>
                        <button
                            className="button"
                            type="button"
                            disabled={!settings?.apiKeyConfigured || busy !== null || characterIds.trim() === ""}
                            onClick={fetchCharacters}
                        >
                            {busy === "characters" ? "Fetching..." : "Fetch characters"}
                        </button>

                        <label>
                            Character used for uploads
                            <select
                                value={selectedCharacterId}
                                disabled={!settings?.characters.length || busy !== null}
                                onChange={(event) => setSelectedCharacterId(event.target.value)}
                            >
                                <option value="">Select a character</option>
                                {settings?.characters.map((character) => (
                                    <option key={character.id} value={character.id}>
                                        {character.name} · class {character.classId}
                                        {character.spec ? ` · ${character.spec}` : ""}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <button
                            className="button primary-button"
                            type="button"
                            disabled={!selectedCharacterId || busy !== null}
                            onClick={saveCharacterSelection}
                        >
                            {busy === "selection" ? "Saving..." : "Save upload character"}
                        </button>
                    </div>
                </section>
            </div>

            {(message || error) && (
                <p className={`${styles.Feedback} ${error ? styles.Error : ""}`} role={error ? "alert" : "status"}>
                    {error || message}
                </p>
            )}
        </>
    );
}
