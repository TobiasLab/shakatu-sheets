import { expect, test, vi } from "vitest";
import { createSession } from "../domain/session";
import { createSessionPersistence } from "./sessionPersistence";

test("flush waits for ordered writes, including writes added while waiting", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const save = vi
        .fn()
        .mockImplementationOnce(() => gate)
        .mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const first = createSession();
    const second = { ...first, elapsedMs: 1000 };
    const firstWrite = queue.enqueue(first);
    const flush = queue.flush();
    const secondWrite = queue.enqueue(second);
    await Promise.resolve();
    release();
    await Promise.all([firstWrite, secondWrite, flush]);
    expect(save.mock.calls.map(([session]) => session.elapsedMs)).toEqual([0, 1000]);
});

test("flush retries the newest failed snapshot and reports a persistent failure", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
    const queue = createSessionPersistence(save);
    const session = createSession();
    await expect(queue.enqueue(session)).rejects.toThrow("disk full");
    await queue.flush();
    expect(save).toHaveBeenLastCalledWith(session);
    save.mockRejectedValue(new Error("disk full"));
    await expect(queue.enqueue({ ...session, elapsedMs: 2000 })).rejects.toThrow();
    await expect(queue.flush()).rejects.toThrow("disk full");
});
