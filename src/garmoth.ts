import type { GarmothUploadInput } from "./api/tauri";
import { getGrindSpotDrops, grindSpots } from "./data/grindSpots";
import { calculateTotals, type SessionState } from "./domain/session";

export type GarmothUploadPreview = {
    input: GarmothUploadInput;
    mappedDropCount: number;
    consumableCount: number;
    unmatchedEntries: string[];
};

export function buildGarmothUpload(session: SessionState): GarmothUploadPreview {
    const spot = grindSpots.find((candidate) => candidate.id === session.grindSpotId);
    if (!spot || session.status !== "finished" || !Number.isSafeInteger(session.elapsedMs) || session.elapsedMs <= 0) {
        throw new Error("Only a completed session with a duration can be uploaded.");
    }

    const templates = getGrindSpotDrops(spot.id);
    const drops = Object.fromEntries(templates.map((drop) => [drop.garmothKey, 0]));
    const unmatchedEntries: string[] = [];
    for (const entry of session.entries) {
        if (entry.valuation === "expense") continue;
        const template = templates.find((drop) => drop.name === entry.name);
        if (!template) {
            unmatchedEntries.push(entry.name);
            continue;
        }
        drops[template.garmothKey] += entry.quantity;
    }

    const totals = calculateTotals(session.entries, session.elapsedMs);
    const total = Math.round(totals.net);
    const hourly = Math.round(totals.netPerHour);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(hourly) || hourly < 0) {
        throw new Error("Garmoth uploads require non-negative, whole-silver session totals.");
    }

    return {
        input: {
            sessionId: session.id,
            grindspotId: spot.garmothId,
            minutes: Math.max(1, Math.round(session.elapsedMs / 60_000)),
            hourly,
            total,
            drops,
            global: false,
        },
        mappedDropCount: Object.values(drops).filter((quantity) => quantity > 0).length,
        consumableCount: new Set(
            session.entries.flatMap((entry) =>
                entry.garmothConsumableId === undefined ? [] : [entry.garmothConsumableId],
            ),
        ).size,
        unmatchedEntries: [...new Set(unmatchedEntries)],
    };
}
