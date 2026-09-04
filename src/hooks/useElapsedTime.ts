import { useEffect, useState } from "react";
import { getElapsedMs, type SessionState } from "../domain/session";
import { useWindowVisible } from "./useWindowVisible";

export function useElapsedTime(session: SessionState, visible: boolean) {
    const windowVisible = useWindowVisible();
    const [, tick] = useState(0);
    useEffect(() => {
        if (!visible || !windowVisible || session.status !== "running") return;
        const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
        return () => window.clearInterval(timer);
    }, [visible, windowVisible, session.status]);
    // Compute from timestamps so returning to the app never resumes a stale clock.
    return getElapsedMs(session, Date.now());
}
