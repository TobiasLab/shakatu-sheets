import { describe, expect, it } from "vitest";
import mappings from "./data/garmothMappings.json";
import { getGrindSpotDrops, grindSpots, supplementalDrops } from "./data/grindSpots";
import type { SessionState } from "./domain/session";
import { buildGarmothUpload, getGarmothUploadBlockReason, parseGarmothOptions } from "./garmoth";

function finishedSession(): SessionState {
    return {
        id: "session-1",
        status: "finished",
        region: "eu",
        grindSpotId: "stars-end-revamp",
        startedAt: null,
        elapsedMs: 5_400_000,
        entries: [
            {
                id: "trash",
                name: "Corrupted Sanguine Crystal",
                quantity: 10_000,
                unitPrice: 155_000,
                valuation: "vendor",
                saleMultiplier: 1,
                source: "manual",
                createdAt: 1,
            },
            {
                id: "stone",
                name: "Black Stone",
                quantity: 10,
                unitPrice: 100_000,
                valuation: "market",
                saleMultiplier: 0.845,
                source: "manual",
                createdAt: 2,
            },
            {
                id: "expense",
                name: "Tent buff",
                quantity: 1,
                unitPrice: 50_000_000,
                valuation: "expense",
                saleMultiplier: 1,
                source: "manual",
                createdAt: 3,
            },
        ],
    };
}

describe("buildGarmothUpload", () => {
    it("keeps the backend mapping manifest aligned with grind-spot profiles", () => {
        for (const spot of grindSpots) {
            const keys = getGrindSpotDrops(spot.id).map((drop) => drop.garmothKey);
            expect(new Set(keys).size).toBe(keys.length);
        }
        expect(mappings).toEqual(
            Object.fromEntries(
                grindSpots.map((spot) => [
                    spot.id,
                    {
                        garmothId: spot.garmothId,
                        drops: Object.fromEntries(
                            [spot.trash, ...spot.drops].map((drop) => [drop.name, drop.garmothKey]),
                        ),
                    },
                ]),
            ),
        );
    });

    it("maps duration, net income, and profile drop keys", () => {
        const preview = buildGarmothUpload(finishedSession());

        expect(preview.input).toMatchObject({
            sessionId: "session-1",
            grindspotId: 200,
            minutes: 90,
            hourly: 1_000_563_333,
            total: 1_500_845_000,
            global: false,
        });
        expect(preview.input.drops["56339_0"]).toBe(10_000);
        expect(preview.input.drops["16001_0"]).toBe(10);
        expect(preview.unmatchedEntries).toEqual([]);
        expect(preview.mappedDropCount).toBe(2);
    });

    it("maps a completed session for every imported spot", () => {
        for (const spot of grindSpots.filter((spot) => spot.id.startsWith("garmoth-"))) {
            const session = finishedSession();
            session.grindSpotId = spot.id;
            session.entries = [
                {
                    ...session.entries[0],
                    name: spot.trash.name,
                    unitPrice: spot.trash.unitPrice ?? 0,
                    quantity: 100,
                },
            ];
            const preview = buildGarmothUpload(session);
            expect(preview.input.grindspotId).toBe(spot.garmothId);
            expect(preview.input.drops[spot.trash.garmothKey]).toBe(100);
            expect(preview.input.total).toBe(100 * (spot.trash.unitPrice ?? 0));
            expect(preview.unmatchedEntries).toEqual([]);
        }
    });

    it("reports unsupported revenue entries instead of silently dropping them", () => {
        const session = finishedSession();
        session.entries.push({ ...session.entries[0], id: "custom", name: "Custom loot" });

        expect(buildGarmothUpload(session).unmatchedEntries).toEqual(["Custom loot"]);
    });

    it("blocks supplemental items outside the spot table while preserving their local income", () => {
        const session = finishedSession();
        const original = buildGarmothUpload(session);
        for (const drop of supplementalDrops) {
            session.entries.push({
                ...session.entries[0],
                id: drop.garmothKey,
                name: drop.name,
                quantity: 2,
                valuation: drop.valuation,
                unitPrice: drop.unitPrice ?? 2_330_000,
                saleMultiplier: drop.valuation === "market" ? 0.845 : 1,
            });
        }
        const preview = buildGarmothUpload(session);
        expect(preview.unmatchedEntries).toEqual(supplementalDrops.map((drop) => drop.name));
        expect(preview.input.drops).toEqual(original.input.drops);
        expect(preview.input.total).toBe(original.input.total + 21_000_000 + 4_660_000 * 0.845);
        expect(getGarmothUploadBlockReason(preview)).toContain("blocked until support is confirmed");
        expect(getGarmothUploadBlockReason(preview)).not.toContain("Reopen");
    });

    it("allows Pure Forest Breath when the spot already lists it", () => {
        const session = finishedSession();
        const spot = grindSpots.find((spot) => spot.name === "Manshaum Forest");
        if (!spot) throw new Error("Missing Manshaum Forest profile");
        session.grindSpotId = spot.id;
        session.entries = [{ ...session.entries[0], name: "Pure Forest Breath", quantity: 3 }];
        const preview = buildGarmothUpload(session);
        expect(preview.input.drops["50807_0"]).toBe(3);
        expect(preview.unmatchedEntries).toEqual([]);
        expect(getGarmothUploadBlockReason(preview)).toBe("");
    });

    it("explains supplemental and unknown entries separately", () => {
        const session = finishedSession();
        for (const name of ["Laila's Petal", "Custom loot"]) {
            session.entries.push({ ...session.entries[0], id: name, name, quantity: 1 });
        }
        const reason = getGarmothUploadBlockReason(buildGarmothUpload(session));
        expect(reason).toContain("Garmoth does not list these items for this spot: Laila's Petal.");
        expect(reason).toContain("Unmapped loot: Custom loot. Reopen the session to correct it.");
    });
});

it("previews saved consumable expenses without treating them as loot", () => {
    const session = finishedSession();
    const before = buildGarmothUpload(session);
    session.entries.push({
        id: "consumable",
        name: "Perfume of Envy",
        quantity: 3,
        unitPrice: 100,
        valuation: "expense",
        saleMultiplier: 1,
        source: "manual",
        createdAt: 0,
        garmothConsumableId: 1411,
    });
    const preview = buildGarmothUpload(session);
    expect(preview.consumableCount).toBe(1);
    expect(preview.input.drops).toEqual(before.input.drops);
    expect(preview.input.total).toBe(before.input.total - 300);
    expect(preview.unmatchedEntries).toEqual(before.unmatchedEntries);
});

describe("upload options", () => {
    it("omits unspecified Agris and drop rate without enabling global contribution", () => {
        expect(JSON.parse(JSON.stringify(parseGarmothOptions(false, false, "900", "")))).toEqual({ global: false });
    });
    it("maps unknown and known Agris and sends percentages directly", () => {
        expect(parseGarmothOptions(true, true, "", "250.25")).toEqual({ global: true, agris: -1, rate: 250.25 });
        expect(parseGarmothOptions(false, true, "20000", "0")).toEqual({ global: false, agris: 20000, rate: 0 });
    });
    it.each(["0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"])("rejects invalid Agris amount %s", (value) => {
        expect(() => parseGarmothOptions(false, true, value, "")).toThrow();
    });
    it.each(["-1", "1.001", "Infinity", "NaN", "1e3", "9007199254740992"])("rejects invalid drop rate %s", (value) => {
        expect(() => parseGarmothOptions(false, false, "", value)).toThrow();
    });
});
