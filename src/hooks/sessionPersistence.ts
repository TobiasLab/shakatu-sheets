import type { SessionState } from "../domain/session";

export const SESSION_AUTOSAVE_INTERVAL_MS = 60_000;

// Retain unsaved snapshots for every session, including a session replaced after finishing.
export function createSessionPersistence(save: (session: SessionState) => Promise<unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    const records = new Map<
        string,
        { latest: SessionState; queued: SessionState | null; saved: SessionState | null }
    >();
    let previous: SessionState | null = null;

    function stage(session: SessionState) {
        const record = records.get(session.id);
        if (record) record.latest = session;
        else records.set(session.id, { latest: session, queued: null, saved: null });
    }

    function savePending() {
        const writes: Promise<unknown>[] = [];
        for (const record of records.values()) {
            const snapshot = record.latest;
            if (snapshot === record.saved || snapshot === record.queued) continue;
            record.queued = snapshot;
            const writing = pending.then(() => save(snapshot));
            pending = writing.then(
                () => {
                    record.saved = snapshot;
                    if (record.queued === snapshot) record.queued = null;
                    if (record.latest === snapshot && snapshot.id !== previous?.id) records.delete(snapshot.id);
                },
                () => {
                    if (record.queued === snapshot) record.queued = null;
                },
            );
            writes.push(writing);
        }
        return Promise.all(writes);
    }

    function enqueue(session: SessionState) {
        stage(session);
        return savePending();
    }

    function update(session: SessionState) {
        const immediate = !previous || previous.id !== session.id || previous.status !== session.status;
        previous = session;
        for (const [id, record] of records) {
            if (id !== session.id && record.latest === record.saved && !record.queued) records.delete(id);
        }
        stage(session);
        return immediate ? savePending() : Promise.resolve([]);
    }

    async function flush() {
        for (;;) {
            const waiting = pending;
            await waiting;
            if (waiting !== pending) continue;
            await savePending();
            if ([...records.values()].every((record) => record.latest === record.saved)) return;
        }
    }

    function startAutosave() {
        const timer = setInterval(() => {
            // The caller's save function reports failures; retain the snapshot for retry.
            void savePending().catch(() => undefined);
        }, SESSION_AUTOSAVE_INTERVAL_MS);
        return () => clearInterval(timer);
    }

    return { enqueue, update, savePending, flush, startAutosave };
}
