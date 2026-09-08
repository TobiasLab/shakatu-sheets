import { describe, expect, it } from "vitest";
import mappings from "./data/garmothMappings.json";
import { getGrindSpotDrops, grindSpots } from "./data/grindSpots";
import type { SessionState } from "./domain/session";
import { buildGarmothUpload } from "./garmoth";

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
                            getGrindSpotDrops(spot.id).map((drop) => [drop.name, drop.garmothKey]),
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

    it("reports unsupported revenue entries instead of silently dropping them", () => {
        const session = finishedSession();
        session.entries.push({ ...session.entries[0], id: "custom", name: "Custom loot" });

        expect(buildGarmothUpload(session).unmatchedEntries).toEqual(["Custom loot"]);
    });
});
