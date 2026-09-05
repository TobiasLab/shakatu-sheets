import type { SessionState } from "../domain/session";

// The queue preserves write order; flush retries the newest snapshot after a failed write.
export function createSessionPersistence(save: (session: SessionState) => Promise<unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    let latest: SessionState | null = null;
    let failed = false;
    function enqueue(session: SessionState) {
        latest = session;
        const writing = pending.catch(() => undefined).then(() => save(session));
        pending = writing.then(
            () => {
                failed = false;
            },
            () => {
                failed = true;
            },
        );
        return writing;
    }
    async function flush() {
        for (;;) {
            const waiting = pending;
            await waiting;
            if (waiting !== pending) continue;
            if (failed && latest) {
                await enqueue(latest);
                continue;
            }
            return;
        }
    }
    return { enqueue, flush };
}
