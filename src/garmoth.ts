import type { GarmothUploadInput } from "./api/tauri";
import importedBuffs from "./data/garmothBuffs.json";
import { grindSpots } from "./data/grindSpots";
import { calculateTotals, type SessionState } from "./domain/session";

export type GarmothBuff = { id: number; name: string; icon: string | null; amount: number; group: string | null };
export const garmothBuffs = importedBuffs as GarmothBuff[];

export type GarmothUploadPreview = {
    input: GarmothUploadInput;
    mappedDropCount: number;
    consumableCount: number;
    omittedEntries: string[];
};

export function buildGarmothUpload(session: SessionState): GarmothUploadPreview {
    const spot = grindSpots.find((candidate) => candidate.id === session.grindSpotId);
    if (!spot || session.status !== "finished" || !Number.isSafeInteger(session.elapsedMs) || session.elapsedMs <= 0) {
        throw new Error("Only a completed session with a duration can be uploaded.");
    }

    // Only spot-listed items are supported for upload, even when more items can be tracked locally.
    const templates = [spot.trash, ...spot.drops];
    const drops = Object.fromEntries(templates.map((drop) => [drop.garmothKey, 0]));
    const omittedEntries: string[] = [];
    for (const entry of session.entries) {
        if (entry.valuation === "expense") continue;
        const template = templates.find((drop) => drop.name === entry.name);
        if (!template) {
            omittedEntries.push(entry.name);
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
        omittedEntries: [...new Set(omittedEntries)],
    };
}

export function getGarmothUploadNotice(preview: GarmothUploadPreview): string {
    return preview.omittedEntries.length
        ? `Not sent in Garmoth's item list: ${preview.omittedEntries.join(", ")}. Session totals still include these items.`
        : "";
}

// Choosing a buff replaces any other tier of the same buff.
export function chooseBuff(selected: number[], buff: GarmothBuff, chosen: boolean): number[] {
    const others = selected.filter(
        (id) =>
            id !== buff.id &&
            (buff.group === null || garmothBuffs.find((candidate) => candidate.id === id)?.group !== buff.group),
    );
    return chosen ? [...others, buff.id] : others;
}

export function dropAmount(selected: number[]): number {
    return garmothBuffs.reduce((sum, buff) => (selected.includes(buff.id) ? sum + buff.amount : sum), 0);
}

export function parseGarmothOptions(global: boolean, usedAgris: boolean, agrisAmount: string) {
    let agris: number | undefined;
    if (usedAgris) {
        agris = agrisAmount.trim() ? Number(agrisAmount) : -1;
        if (agrisAmount.trim() && (!/^[0-9]+$/.test(agrisAmount.trim()) || !Number.isSafeInteger(agris) || agris <= 0))
            throw new Error("Enter a positive whole Agris amount, or leave it blank for unknown.");
    }
    return { global, agris };
}
