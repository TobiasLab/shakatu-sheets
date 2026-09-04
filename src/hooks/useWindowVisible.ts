import { useEffect, useState } from "react";
import { supportsTauriApi } from "../api/tauri";

// Visibility pauses presentation only. Capture and recognition own their independent lifecycle.
export function useWindowVisible() {
    const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
    useEffect(() => {
        let disposed = false;
        let minimized = false;
        let revision = 0;
        let unlisten: (() => void) | undefined;
        const update = () => {
            if (!disposed) setVisible(!minimized && document.visibilityState !== "hidden");
        };
        document.addEventListener("visibilitychange", update);
        if (supportsTauriApi()) {
            void import("@tauri-apps/api/window")
                .then(async ({ getCurrentWindow }) => {
                    const window = getCurrentWindow();
                    const refresh = async () => {
                        const request = ++revision;
                        const next = await window.isMinimized();
                        if (disposed || request !== revision) return;
                        minimized = next;
                        update();
                    };
                    const stop = await window.onResized(() => {
                        void refresh().catch(() => undefined);
                    });
                    if (disposed) {
                        void Promise.resolve(stop()).catch(() => undefined);
                        return;
                    }
                    unlisten = stop;
                    await refresh();
                })
                .catch(() => undefined);
        }
        return () => {
            disposed = true;
            document.removeEventListener("visibilitychange", update);
            if (unlisten) void Promise.resolve(unlisten()).catch(() => undefined);
        };
    }, []);
    return visible;
}
