import { type FormEvent, useEffect, useState } from "react";
import {
    fetchGarmothCharacters,
    type GarmothSettings,
    loadGarmothSettings,
    saveGarmothApiKey,
    selectGarmothCharacter,
} from "../../api/tauri";
import type { Theme } from "../../hooks/useTheme";
import styles from "./Settings.module.css";

export function SettingsView({
    theme,
    onThemeChange,
    onOpenCapture,
}: {
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    onOpenCapture: () => void;
}) {
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
                    <p className="eyebrow">Local configuration</p>
                    <h1>Settings</h1>
                </div>
            </header>

            <div className={styles.Preferences}>
                <section className="panel">
                    <div className="panel-heading">
                        <div>
                            <p className="eyebrow">Make yourself at home</p>
                            <h2>Appearance</h2>
                        </div>
                    </div>
                    <div className={styles.SettingsForm}>
                        <label>
                            Theme
                            <select value={theme} onChange={(event) => onThemeChange(event.target.value as Theme)}>
                                <option value="dark">Charcoal & gold</option>
                                <option value="moss">Moss green</option>
                                <option value="light">Light</option>
                            </select>
                        </label>
                    </div>
                </section>
                <section className="panel">
                    <div className="panel-heading">
                        <div>
                            <p className="eyebrow">While you play</p>
                            <h2>Capture</h2>
                        </div>
                    </div>
                    <div className={styles.SettingsForm}>
                        <p>
                            Tracking continues while you browse or minimize. Live previews run only when setup is open
                            and visible.
                        </p>
                        <button type="button" className="button" onClick={onOpenCapture}>
                            Go to capture setup
                        </button>
                    </div>
                </section>
            </div>
            <h2 className={styles.SectionTitle}>Garmoth integration</h2>
            <p className={styles.SectionNote}>Connect your account to publish finished sessions when you choose.</p>
            <div className={styles.SettingsGrid}>
                <section className="panel">
                    <div className="panel-heading">
                        <div>
                            <p className="eyebrow">Garmoth</p>
                            <h2>API connection</h2>
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
                            <p className="eyebrow">Upload identity</p>
                            <h2>Character build</h2>
                        </div>
                    </div>
                    <div className={styles.SettingsForm}>
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
