import { useEffect, useRef, useState } from "react";

export type PersistedSetting<T> = ReturnType<typeof usePersistedSetting<T>>;

// Loads a SQLite setting once and saves changes in order, so an older write never lands after a newer one.
// With `requireLoad`, a failed load leaves the default unconfirmed (`loaded` stays false) until a save succeeds.
export function usePersistedSetting<T>(
    initial: T,
    load: () => Promise<T>,
    save: (value: T) => Promise<unknown>,
    label: string,
    requireLoad = false,
) {
    const [value, setValue] = useState(initial);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const writes = useRef<Promise<unknown>>(Promise.resolve());
    useEffect(() => {
        let disposed = false;
        load().then(
            (saved) => {
                if (disposed) return;
                setValue(saved);
                setLoaded(true);
            },
            (failure) => {
                if (disposed) return;
                setError(`Could not load ${label}: ${String(failure)}`);
                if (!requireLoad) setLoaded(true);
            },
        );
        return () => {
            disposed = true;
        };
    }, []);

    function update(next: T) {
        setValue(next);
        setSaving(true);
        setError("");
        const writing = writes.current.catch(() => undefined).then(() => save(next));
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
                    setError(`Could not save ${label}: ${String(failure)}`);
                }
            },
        );
        return writing;
    }

    async function flush() {
        await writes.current.catch(() => update(value));
    }

    return { value, loaded, saving, error, update, flush };
}
