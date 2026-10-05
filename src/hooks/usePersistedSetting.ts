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
    const [failure, setFailure] = useState<{ during: "load" | "save"; message: string } | null>(null);
    const writes = useRef<Promise<unknown>>(Promise.resolve());
    // Each load or update takes a new number, so a load that finishes late cannot replace a newer value.
    const latest = useRef(0);

    function reload() {
        const request = ++latest.current;
        setFailure(null);
        load().then(
            (saved) => {
                if (request !== latest.current) return;
                setValue(saved);
                setLoaded(true);
            },
            (error) => {
                if (request !== latest.current) return;
                setFailure({ during: "load", message: `Could not load ${label}: ${String(error)}` });
                if (!requireLoad) setLoaded(true);
            },
        );
    }

    useEffect(() => {
        reload();
        return () => {
            latest.current += 1;
        };
    }, []);

    function update(next: T) {
        latest.current += 1;
        setValue(next);
        setSaving(true);
        setFailure(null);
        const writing = writes.current.catch(() => undefined).then(() => save(next));
        writes.current = writing;
        void writing.then(
            () => {
                if (writing === writes.current) {
                    setSaving(false);
                    setLoaded(true);
                }
            },
            (error) => {
                if (writing === writes.current) {
                    setSaving(false);
                    setFailure({ during: "save", message: `Could not save ${label}: ${String(error)}` });
                }
            },
        );
        return writing;
    }

    // After a failed load this reloads rather than saving the unconfirmed default over the stored value.
    function retry() {
        if (failure?.during === "load") reload();
        else void update(value);
    }

    async function flush() {
        await writes.current.catch(() => update(value));
    }

    return {
        value,
        loaded,
        saving,
        error: failure?.message ?? "",
        failedTo: failure?.during ?? null,
        update,
        retry,
        flush,
    };
}
