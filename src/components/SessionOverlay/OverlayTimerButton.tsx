import { useState } from "react";
import { requestOverlayTimer } from "../../api/sessionOverlay";
import type { SessionState } from "../../domain/session";
import styles from "./SessionOverlay.module.css";

export function OverlayTimerButton({ session, enabled }: { session: SessionState; enabled: boolean }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const action = session.status === "running" ? "pause" : session.status === "paused" ? "resume" : "start";
    const label = action === "pause" ? "Pause timer" : action === "resume" ? "Resume timer" : "Start timer";
    return (
        <div>
            {session.status !== "finished" && (
                <button
                    type="button"
                    className={styles.TimerButton}
                    disabled={!enabled || busy}
                    onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                            await requestOverlayTimer(session.id, action);
                        } catch (error) {
                            setError(String(error));
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {busy ? "Updating…" : label}
                </button>
            )}
            {error && (
                <p role="alert" className={styles.ControlError}>
                    {error}
                </p>
            )}
        </div>
    );
}
