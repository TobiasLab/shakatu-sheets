import { describe, expect, it } from "vitest";
import mappings from "./data/garmothMappings.json";
import { getGrindSpotDrops, grindSpots, supplementalDrops } from "./data/grindSpots";
import type { SessionState } from "./domain/session";
import {
    buildGarmothUpload,
    chooseBuff,
    dropAmount,
    type GarmothBuff,
    garmothBuffs,
    getGarmothUploadNotice,
    parseGarmothOptions,
} from "./garmoth";

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
        expect(preview.omittedEntries).toEqual([]);
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
            expect(preview.omittedEntries).toEqual([]);
        }
    });

    it("reports unsupported revenue entries omitted from the upload", () => {
        const session = finishedSession();
        session.entries.push({ ...session.entries[0], id: "custom", name: "Custom loot" });

        expect(buildGarmothUpload(session).omittedEntries).toEqual(["Custom loot"]);
    });

    it("omits supplemental items outside the spot table while preserving their income", () => {
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
        expect(preview.omittedEntries).toEqual(supplementalDrops.map((drop) => drop.name));
        expect(preview.input.drops).toEqual(original.input.drops);
        expect(preview.input.total).toBe(original.input.total + 21_000_000 + 4_660_000 * 0.845);
        expect(getGarmothUploadNotice(preview)).toContain("Session totals still include these items.");
        expect(getGarmothUploadNotice(preview)).not.toContain("Reopen");
    });

    it("allows Pure Forest Breath when the spot already lists it", () => {
        const session = finishedSession();
        const spot = grindSpots.find((spot) => spot.name === "Manshaum Forest");
        if (!spot) throw new Error("Missing Manshaum Forest profile");
        session.grindSpotId = spot.id;
        session.entries = [{ ...session.entries[0], name: "Pure Forest Breath", quantity: 3 }];
        const preview = buildGarmothUpload(session);
        expect(preview.input.drops["50807_0"]).toBe(3);
        expect(preview.omittedEntries).toEqual([]);
        expect(getGarmothUploadNotice(preview)).toBe("");
    });

    it("lists supplemental and unknown items together as omitted", () => {
        const session = finishedSession();
        for (const name of ["Laila's Petal", "Custom loot"]) {
            session.entries.push({ ...session.entries[0], id: name, name, quantity: 1 });
        }
        const reason = getGarmothUploadNotice(buildGarmothUpload(session));
        expect(reason).toBe(
            "Not sent in Garmoth's item list: Laila's Petal, Custom loot. Session totals still include these items.",
        );
    });

    it("allows sessions with only unsupported loot and lists repeated omissions once", () => {
        const session = finishedSession();
        session.entries = ["Custom loot", "Custom loot", "Laila's Petal"].map((name, index) => ({
            ...session.entries[0],
            id: String(index),
            name,
            quantity: 1,
            unitPrice: 500_000,
        }));
        const before = structuredClone(session);
        const preview = buildGarmothUpload(session);
        expect(preview.omittedEntries).toEqual(["Custom loot", "Laila's Petal"]);
        expect(preview.mappedDropCount).toBe(0);
        expect(Object.values(preview.input.drops).every((quantity) => quantity === 0)).toBe(true);
        expect(preview.input.total).toBe(1_500_000);
        expect(preview.input.hourly).toBe(1_000_000);
        expect(session).toEqual(before);
        expect(preview.input.expectedSession).toEqual(before);
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
    expect(preview.omittedEntries).toEqual(before.omittedEntries);
});

describe("upload options", () => {
    it("omits unspecified Agris without enabling global contribution", () => {
        expect(JSON.parse(JSON.stringify(parseGarmothOptions(false, false, "900")))).toEqual({ global: false });
    });
    it("maps unknown and known Agris", () => {
        expect(parseGarmothOptions(true, true, "")).toEqual({ global: true, agris: -1 });
        expect(parseGarmothOptions(false, true, "20000")).toEqual({ global: false, agris: 20000 });
    });
    it.each(["0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"])("rejects invalid Agris amount %s", (value) => {
        expect(() => parseGarmothOptions(false, true, value)).toThrow();
    });
});

describe("drop buffs", () => {
    const buff = (id: number) => garmothBuffs.find((candidate) => candidate.id === id) as GarmothBuff;

    it("keeps one tier of each buff and toggles buffs off", () => {
        // Loot scroll Lv. 1 and Lv. 2, Adventurer's Luck I and V, Eye of Arsha.
        let selected = chooseBuff([], buff(1), true);
        selected = chooseBuff(selected, buff(36), true);
        selected = chooseBuff(selected, buff(2), true);
        expect(selected).toEqual([36, 2]);
        selected = chooseBuff(chooseBuff(selected, buff(12), true), buff(8), true);
        expect(selected).toEqual([36, 2, 8]);
        expect(chooseBuff(selected, buff(36), false)).toEqual([2, 8]);
    });

    it("sums drop amounts of the chosen buffs", () => {
        expect(dropAmount([])).toBe(0);
        // Loot scroll Lv. 2, Adventurer's Luck V, Blessing of Old Moon Scroll.
        expect(dropAmount([2, 8, 138])).toBe(200);
    });

    it("bundles only known tier groups with unique IDs", () => {
        expect(new Set(garmothBuffs.map((candidate) => candidate.id)).size).toBe(garmothBuffs.length);
        expect(new Set(garmothBuffs.flatMap((candidate) => candidate.group ?? []))).toEqual(
            new Set(["loot-scroll", "adventurers-luck", "node-war-benefit", "fortuna"]),
        );
    });
});
