import { useEffect, useRef, useState } from "react";
import { loadLootFont, saveLootFont } from "../api/lootFont";
import type { LootFont } from "../recognition/lootFont";

export function useLootFont() {
    const [font, setFont] = useState<LootFont>("korean");
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const writes = useRef(Promise.resolve());
    useEffect(() => {
        let disposed = false;
        void loadLootFont()
            .then((value) => {
                if (!disposed) {
                    setFont(value);
                    setLoaded(true);
                }
            })
            .catch((failure) => {
                if (!disposed) setError(`Could not load in-game font: ${String(failure)}`);
            });
        return () => {
            disposed = true;
        };
    }, []);

    function updateFont(value: LootFont) {
        setFont(value);
        setSaving(true);
        setError("");
        const writing = writes.current.catch(() => undefined).then(() => saveLootFont(value));
        writes.current = writing;
        void writing.then(
            () => {
                if (writing === writes.current) {
                    setSaving(false);
                    setLoaded(true);
                }
            },
            (failure) => {
                if (writing === writes.current) {
                    setSaving(false);
                    setError(`Could not save in-game font: ${String(failure)}`);
                }
            },
        );
        return writing;
    }

    async function flush() {
        await writes.current.catch(() => updateFont(font));
    }

    return { font, loaded, saving, error, updateFont, flush };
}
