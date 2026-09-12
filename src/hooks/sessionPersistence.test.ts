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

test("autosave batches continuous changes every minute without resetting the timer", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const stop = queue.startAutosave();
    try {
        const session = createSession();
        await queue.update(session);
        save.mockClear();
        for (let second = 1; second <= 59; second++) {
            await vi.advanceTimersByTimeAsync(1000);
            await queue.update({ ...session, elapsedMs: second * 1000 });
        }
        expect(save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenLastCalledWith({ ...session, elapsedMs: 59000 });
        await vi.advanceTimersByTimeAsync(60000);
        expect(save).toHaveBeenCalledTimes(1);
        await queue.update({ ...session, elapsedMs: 120000 });
        await vi.advanceTimersByTimeAsync(60000);
        expect(save).toHaveBeenCalledTimes(2);
        stop();
        await queue.update({ ...session, elapsedMs: 180000 });
        await vi.advanceTimersByTimeAsync(60000);
        expect(save).toHaveBeenCalledTimes(2);
    } finally {
        stop();
        vi.useRealTimers();
    }
});

test("session transitions save immediately and close flushes staged edits", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const session = createSession();
    await queue.update(session);
    for (const status of ["running", "paused", "running", "finished"] as const) {
        await queue.update({ ...session, status });
        expect(save).toHaveBeenLastCalledWith({ ...session, status });
    }
    const next = { ...createSession(), id: "next-session" };
    await queue.update(next);
    const edited = { ...next, elapsedMs: 1000 };
    await queue.update(edited);
    expect(save).toHaveBeenCalledTimes(6);
    await queue.flush();
    expect(save).toHaveBeenLastCalledWith(edited);
});

test("flush includes edits staged during an in-flight write", async () => {
    let release: () => void = () => undefined;
    const save = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        )
        .mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const session = createSession();
    const initial = queue.update(session);
    await Promise.resolve();
    const closing = queue.flush();
    const edited = { ...session, elapsedMs: 1000 };
    await queue.update(edited);
    release();
    await Promise.all([initial, closing]);
    expect(save.mock.calls.map(([snapshot]) => snapshot.elapsedMs)).toEqual([0, 1000]);
});

test("failed autosaves retry the latest snapshot on the next minute", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const stop = queue.startAutosave();
    try {
        const session = createSession();
        await queue.update(session);
        await queue.update({ ...session, elapsedMs: 1000 });
        save.mockRejectedValueOnce(new Error("disk full"));
        await vi.advanceTimersByTimeAsync(60000);
        const latest = { ...session, elapsedMs: 2000 };
        await queue.update(latest);
        await vi.advanceTimersByTimeAsync(60000);
        expect(save).toHaveBeenCalledTimes(3);
        expect(save).toHaveBeenLastCalledWith(latest);
        await queue.flush();
        expect(save).toHaveBeenCalledTimes(3);
    } finally {
        stop();
        vi.useRealTimers();
    }
});

test("a failed finished-session save survives switching to a new session", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const session = createSession();
    await queue.update(session);
    const finished = { ...session, status: "finished" as const };
    save.mockRejectedValueOnce(new Error("disk full"));
    await expect(queue.update(finished)).rejects.toThrow("disk full");
    const next = { ...createSession(), id: "next-session" };
    await queue.update(next);
    await queue.flush();
    expect(save.mock.calls.map(([snapshot]) => snapshot)).toEqual([session, finished, finished, next]);
});

test("slow autosaves do not duplicate snapshots and preserve newer edits", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSessionPersistence(save);
    const stop = queue.startAutosave();
    try {
        const session = createSession();
        await queue.update(session);
        let release: () => void = () => undefined;
        save.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const first = { ...session, elapsedMs: 1000 };
        await queue.update(first);
        await vi.advanceTimersByTimeAsync(120000);
        expect(save).toHaveBeenCalledTimes(2);
        const latest = { ...session, elapsedMs: 2000 };
        await queue.update(latest);
        release();
        await vi.advanceTimersByTimeAsync(60000);
        expect(save.mock.calls.map(([snapshot]) => snapshot)).toEqual([session, first, latest]);
    } finally {
        stop();
        vi.useRealTimers();
    }
});
