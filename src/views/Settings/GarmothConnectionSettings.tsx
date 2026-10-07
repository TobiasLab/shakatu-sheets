import { type FormEvent, useEffect, useState } from "react";
import {
    fetchGarmothCharacters,
    type GarmothSettings,
    inspectGarmothConsumables,
    loadGarmothSettings,
    saveGarmothApiKey,
    selectGarmothCharacter,
} from "../../api/tauri";
import { Feedback } from "../../components/Feedback/Feedback";
import { FormField } from "../../components/FormField/FormField";
import styles from "./Settings.module.css";

// The API key, upload character, and connection diagnostics load and save on their own, independent of the session.
export function GarmothConnectionSettings() {
    const [settings, setSettings] = useState<GarmothSettings | null>(null);
    const [characterIds, setCharacterIds] = useState("");
    const [selectedCharacterId, setSelectedCharacterId] = useState("");
    const [busy, setBusy] = useState<"key" | "characters" | "selection" | "inspection" | null>(null);
    const [includeFieldNames, setIncludeFieldNames] = useState(false);
    const [consumableReport, setConsumableReport] = useState("");
    const [feedbackTarget, setFeedbackTarget] = useState<"key" | "character">("key");
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    async function reloadSettings() {
        const loaded = await loadGarmothSettings();
        setConsumableReport("");
        setSettings(loaded);
        setCharacterIds(loaded.characterIds.join(", "));
        setSelectedCharacterId(loaded.selectedCharacterId?.toString() ?? "");
    }

    async function readSettings() {
        setSettingsLoading(true);
        setError("");
        setFeedbackTarget("key");
        try {
            await reloadSettings();
        } catch (failure) {
            setError(`Could not load Garmoth settings: ${String(failure)}`);
        } finally {
            setSettingsLoading(false);
        }
    }
    useEffect(() => {
        void readSettings();
    }, []);

    async function saveApiKey(event: FormEvent<HTMLFormElement>) {
        setFeedbackTarget("key");
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
        setFeedbackTarget("character");
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

    async function inspectConsumables() {
        setFeedbackTarget("character");
        setBusy("inspection");
        setError("");
        setMessage("");
        setConsumableReport("");
        try {
            setConsumableReport(await inspectGarmothConsumables(selectedCharacterId, includeFieldNames));
            setMessage("Consumable report ready.");
        } catch (failure) {
            setError(String(failure));
        } finally {
            setBusy(null);
        }
    }

    async function copyConsumableReport() {
        setFeedbackTarget("character");
        setError("");
        setMessage("");
        try {
            await navigator.clipboard.writeText(consumableReport);
            setMessage("Report copied.");
        } catch {
            setError("Could not copy. Select the report and copy it manually.");
        }
    }

    async function saveCharacterSelection() {
        setFeedbackTarget("character");
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

    const feedback = (message || error) && <Feedback tone={error ? "error" : "success"}>{error || message}</Feedback>;
    return (
        <>
            <section className="panel">
                <div className="panel-heading">
                    <div>
                        <h2>Garmoth</h2>
                    </div>
                    <span className={styles.ConnectionStatus}>
                        {settings?.apiKeyConfigured
                            ? "Configured"
                            : settings === null && !error
                              ? "Loading..."
                              : "Not configured"}
                    </span>
                </div>
                <form className={styles.SettingsForm} onSubmit={saveApiKey}>
                    <FormField label="API key">
                        <input
                            name="apiKey"
                            disabled={busy !== null || settingsLoading}
                            type="password"
                            required
                            maxLength={512}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={settings?.apiKeyConfigured ? "Enter a replacement key" : "Garmoth API key"}
                        />
                    </FormField>
                    <p>Your key stays on this device.</p>
                    <button className="button primary-button" type="submit" disabled={busy !== null || settingsLoading}>
                        {busy === "key" ? "Validating..." : "Validate and save key"}
                    </button>
                    {feedbackTarget === "key" && feedback}
                    {settings === null && error && (
                        <button
                            type="button"
                            className="button"
                            disabled={settingsLoading}
                            onClick={() => void readSettings()}
                        >
                            Retry settings
                        </button>
                    )}
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
                    <FormField label="Gear Planner character IDs">
                        <input
                            value={characterIds}
                            disabled={!settings?.apiKeyConfigured || busy !== null}
                            onChange={(event) => setCharacterIds(event.target.value)}
                            placeholder="dNTbRAtHn1"
                        />
                    </FormField>
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

                    <FormField label="Character used for uploads">
                        <select
                            value={selectedCharacterId}
                            disabled={!settings?.characters.length || busy !== null}
                            onChange={(event) => {
                                setSelectedCharacterId(event.target.value);
                                setConsumableReport("");
                            }}
                        >
                            <option value="">Select a character</option>
                            {settings?.characters.map((character) => (
                                <option key={character.id} value={character.id}>
                                    {character.name} · class {character.classId}
                                    {character.spec ? ` · ${character.spec}` : ""}
                                </option>
                            ))}
                        </select>
                    </FormField>
                    <button
                        className="button primary-button"
                        type="button"
                        disabled={!selectedCharacterId || busy !== null}
                        onClick={saveCharacterSelection}
                    >
                        {busy === "selection" ? "Saving..." : "Save upload character"}
                    </button>
                    {feedbackTarget === "character" && feedback}
                    <details className={styles.Diagnostics}>
                        <summary>Connection diagnostics</summary>
                        <div>
                            <label className={styles.DiagnosticOption}>
                                <input
                                    type="checkbox"
                                    checked={includeFieldNames}
                                    disabled={busy !== null || settingsLoading}
                                    onChange={(event) => {
                                        setIncludeFieldNames(event.target.checked);
                                        setConsumableReport("");
                                    }}
                                />
                                Include response field names
                            </label>
                            {includeFieldNames && <p>Field names may contain custom names. Review before sharing.</p>}
                            <button
                                className="button"
                                type="button"
                                disabled={!settings?.apiKeyConfigured || !selectedCharacterId || busy !== null}
                                onClick={inspectConsumables}
                            >
                                {busy === "inspection" ? "Inspecting..." : "Inspect consumable data"}
                            </button>
                            {consumableReport && (
                                <>
                                    <FormField label="Sanitized consumable report">
                                        <textarea
                                            className={styles.DiagnosticReport}
                                            readOnly
                                            rows={12}
                                            value={consumableReport}
                                        />
                                    </FormField>
                                    <button className="button" type="button" onClick={copyConsumableReport}>
                                        Copy report
                                    </button>
                                </>
                            )}
                        </div>
                    </details>
                </div>
            </section>
        </>
    );
}
