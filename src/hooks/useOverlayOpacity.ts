import { useEffect, useRef, useState } from "react";
import { loadOverlayOpacity, saveOverlayOpacity } from "../api/sessionOverlay";

export function useOverlayOpacity() {
    const [opacity, setOpacity] = useState(100);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const writes = useRef(Promise.resolve());
    useEffect(() => {
        let disposed = false;
        void loadOverlayOpacity()
            .then((value) => {
                if (!disposed) {
                    setOpacity(value);
                    setLoaded(true);
                }
            })
            .catch((error) => {
                if (!disposed) {
                    setError(`Could not load opacity: ${String(error)}`);
                    setLoaded(true);
                }
            });
        return () => {
            disposed = true;
        };
    }, []);

    function updateOpacity(value: number) {
        setOpacity(value);
        setSaving(true);
        setError("");
        const writing = writes.current.catch(() => undefined).then(() => saveOverlayOpacity(value));
        writes.current = writing;
        void writing.then(
            () => {
                if (writing === writes.current) setSaving(false);
            },
            (error) => {
                if (writing === writes.current) {
                    setSaving(false);
                    setError(`Could not save opacity: ${String(error)}`);
                }
            },
        );
        return writing;
    }

    async function flush() {
        await writes.current.catch(() => updateOpacity(opacity));
    }

    return { opacity, loaded, saving, error, updateOpacity, flush };
}
