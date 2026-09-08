import { useState } from "react";
import { requestOverlayTimer } from "../../api/sessionOverlay";
import type { SessionState } from "../../domain/session";
import { Icon } from "../Icon/Icon";
import styles from "./SessionOverlay.module.css";

export function OverlayTimerButton({ session, enabled }: { session: SessionState; enabled: boolean }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const action = session.status === "running" ? "pause" : session.status === "paused" ? "resume" : "start";
    const label = action === "pause" ? "Pause timer" : action === "resume" ? "Resume timer" : "Start timer";
    return (
        <>
            {session.status !== "finished" && (
                <button
                    type="button"
                    className={`button primary-button ${styles.TimerButton}`}
                    aria-label={label}
                    aria-busy={busy}
                    title={busy ? "Updating timer…" : label}
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
                    <Icon name={action === "pause" ? "pause" : "play"} size={16} />
                </button>
            )}
            {error && (
                <p role="alert" className={styles.ControlError}>
                    {error}
                </p>
            )}
        </>
    );
}
