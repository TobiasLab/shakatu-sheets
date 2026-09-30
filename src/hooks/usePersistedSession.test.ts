import { beforeEach, expect, test, vi } from "vitest";
import { listFinishedSessions, loadActiveSession } from "../api/tauri";
import { createSession } from "../domain/session";
import { loadStartingSession } from "./usePersistedSession";

vi.mock("../api/tauri", () => ({ loadActiveSession: vi.fn(), listFinishedSessions: vi.fn() }));

function finished(region: "eu" | "na", grindSpotId: string) {
    const session = { ...createSession(region, grindSpotId), status: "finished" as const };
    return {
        records: [{ session, finishedAt: 1, garmothUploadStatus: null }],
        totalCount: 1,
        offset: 0,
        spotSummaries: [],
    };
}

beforeEach(() => {
    vi.mocked(loadActiveSession).mockResolvedValue(null);
});

test("a new session starts at the last finished session's spot and region", async () => {
    vi.mocked(listFinishedSessions).mockResolvedValue(finished("na", "zephyros-castle"));

    expect(await loadStartingSession()).toMatchObject({ status: "idle", region: "na", grindSpotId: "zephyros-castle" });
});

test("a new session starts at Aphrodon Temple without usable history", async () => {
    vi.mocked(listFinishedSessions).mockResolvedValueOnce(finished("na", "removed-spot"));
    expect(await loadStartingSession()).toMatchObject({ region: "na", grindSpotId: "aphrodon-temple" });

    vi.mocked(listFinishedSessions).mockRejectedValueOnce(new Error("database locked"));
    expect(await loadStartingSession()).toMatchObject({ region: "eu", grindSpotId: "aphrodon-temple" });
});

test("an unfinished session is restored instead of starting a new one", async () => {
    const running = { ...createSession("na", "zephyros-castle"), status: "running" as const, startedAt: 1 };
    vi.mocked(loadActiveSession).mockResolvedValue(running);

    expect(await loadStartingSession()).toMatchObject({ id: running.id, status: "paused" });
});
