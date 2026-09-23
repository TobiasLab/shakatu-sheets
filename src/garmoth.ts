import type { GarmothUploadInput } from "./api/tauri";
import { grindSpots, supplementalDrops } from "./data/grindSpots";
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

    // Only spot-listed items are supported for upload, even when more items can be tracked locally.
    const templates = [spot.trash, ...spot.drops];
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
            expectedSession: session,
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

export function getGarmothUploadBlockReason(preview: GarmothUploadPreview): string {
    const supplementalNames = new Set(supplementalDrops.map((drop) => drop.name));
    const supplemental = preview.unmatchedEntries.filter((name) => supplementalNames.has(name));
    const unknown = preview.unmatchedEntries.filter((name) => !supplementalNames.has(name));
    return [
        supplemental.length
            ? `Garmoth does not list these items for this spot: ${supplemental.join(", ")}. Uploads containing them are blocked until support is confirmed. Your items remain saved locally.`
            : "",
        unknown.length ? `Unmapped loot: ${unknown.join(", ")}. Reopen the session to correct it.` : "",
    ]
        .filter(Boolean)
        .join(" ");
}

export function parseGarmothOptions(global: boolean, usedAgris: boolean, agrisAmount: string, dropRate: string) {
    let agris: number | undefined;
    if (usedAgris) {
        agris = agrisAmount.trim() ? Number(agrisAmount) : -1;
        if (agrisAmount.trim() && (!/^[0-9]+$/.test(agrisAmount.trim()) || !Number.isSafeInteger(agris) || agris <= 0))
            throw new Error("Enter a positive whole Agris amount, or leave it blank for unknown.");
    }
    let rate: number | undefined;
    if (dropRate.trim()) {
        rate = Number(dropRate);
        if (
            !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(dropRate.trim()) ||
            !Number.isFinite(rate) ||
            rate * 100 > Number.MAX_SAFE_INTEGER
        )
            throw new Error("Enter a drop rate of 0 or more with at most two decimal places.");
    }
    return { global, agris, rate };
}
