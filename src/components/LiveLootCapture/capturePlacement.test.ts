import { describe, expect, it } from "vitest";
import type { NormalizedRegion } from "../../recognition/displayCapture";
import {
    type CapturePlacement,
    captureSelectionChanged,
    initialCapturePlacement,
    normalPlacementReady,
    type PlacementAction,
    reducePlacement,
} from "./capturePlacement";

function region(x: number): NormalizedRegion {
    return { x, y: 0.5, width: 0.1, height: 0.1 };
}

function placed(actions: PlacementAction[], from: CapturePlacement = initialCapturePlacement) {
    return actions.reduce(reducePlacement, from);
}

const confirmed = placed([
    {
        type: "configure",
        uiScale: 80,
        normalRegion: region(0.1),
        rareRegion: region(0.2),
        normalConfirmed: true,
        rareConfirmed: true,
    },
]);

describe("capture placement", () => {
    it("keeps the loot stack confirmed while the rare area moves", () => {
        const moved = placed(
            [
                { type: "select", kind: "rare" },
                { type: "move", region: region(0.3) },
            ],
            confirmed,
        );

        expect(moved).toMatchObject({
            mode: "manual",
            normalConfirmed: true,
            rareConfirmed: false,
            rareRegion: region(0.3),
            rareCaptureRegion: region(0.3),
            normalCaptureRegion: region(0.1),
        });
    });

    it("returns moving the loot stack to unconfirmed manual placement", () => {
        const aligned = { ...confirmed, mode: "aligned" as const, normalConfirmed: false };
        const moved = placed([{ type: "move", region: region(0.4) }], aligned);

        expect(moved).toMatchObject({ mode: "manual", normalConfirmed: false, rareConfirmed: true });
        expect(moved.normalCaptureRegion).toEqual(region(0.4));
    });

    it("restores the aligned loot stack after a rare-banner search, whether it locks or is cancelled", () => {
        const aligned = { ...confirmed, mode: "aligned" as const, normalConfirmed: false, activeKind: "rare" as const };
        const searching = placed([{ type: "begin-search", searchRegion: region(0.5) }], aligned);
        expect(searching).toMatchObject({
            mode: "localizing",
            rareConfirmed: false,
            rareCaptureRegion: null,
            normalCaptureRegion: region(0.1),
        });
        expect(normalPlacementReady(searching)).toBe(false);

        const locked = placed([{ type: "lock-search", region: region(0.6), defaultRare: region(0.9) }], searching);
        expect(locked).toMatchObject({
            mode: "aligned",
            searchRegion: null,
            rareRegion: region(0.6),
            rareCaptureRegion: region(0.6),
            rareConfirmed: false,
        });

        const cancelled = placed([{ type: "end-search" }], searching);
        expect(cancelled).toMatchObject({
            mode: "aligned",
            searchRegion: null,
            rareCaptureRegion: region(0.2),
            normalCaptureRegion: region(0.1),
        });
    });

    it("leaves a manually confirmed loot stack confirmed after a rare-banner search", () => {
        const searching = placed(
            [
                { type: "select", kind: "rare" },
                { type: "begin-search", searchRegion: region(0.5) },
            ],
            confirmed,
        );

        expect(placed([{ type: "end-search" }], searching)).toMatchObject({ mode: "manual", normalConfirmed: true });
    });

    it("aligns a found loot stack, places a default rare area, and selects it for confirmation", () => {
        const unplaced = { ...initialCapturePlacement, normalRegion: region(0.1) };
        const locked = placed(
            [
                { type: "begin-search", searchRegion: region(0.5) },
                { type: "lock-search", region: region(0.15), defaultRare: region(0.9) },
            ],
            unplaced,
        );

        expect(locked).toMatchObject({
            mode: "aligned",
            activeKind: "rare",
            normalRegion: region(0.15),
            normalCaptureRegion: region(0.15),
            rareRegion: region(0.9),
            rareCaptureRegion: region(0.9),
        });
        expect(normalPlacementReady(locked)).toBe(true);
    });

    it("keeps a confirmed rare area selected and placed when the loot stack is found", () => {
        const locked = placed(
            [
                { type: "begin-search", searchRegion: region(0.5) },
                { type: "lock-search", region: region(0.15), defaultRare: region(0.9) },
            ],
            confirmed,
        );

        expect(locked).toMatchObject({ activeKind: "normal", rareRegion: region(0.2), rareConfirmed: true });
    });

    it("unconfirms both areas when the UI scale changes and repositions them when the source allows", () => {
        expect(placed([{ type: "scale", uiScale: 100, regions: null }], confirmed)).toMatchObject({
            uiScale: 100,
            normalRegion: region(0.1),
            normalConfirmed: false,
            rareConfirmed: false,
        });
        expect(
            placed([{ type: "scale", uiScale: 100, regions: { normal: region(0.3), rare: region(0.4) } }], confirmed),
        ).toMatchObject({
            mode: "manual",
            normalCaptureRegion: region(0.3),
            rareCaptureRegion: region(0.4),
            normalConfirmed: false,
            rareConfirmed: false,
        });
    });

    it("confirms both areas only after the placement is saved", () => {
        const moved = placed([{ type: "move", region: region(0.4) }], confirmed);
        const pending = placed([{ type: "confirm" }], { ...moved, normalCaptureRegion: null });

        expect(pending).toMatchObject({ normalCaptureRegion: region(0.4), normalConfirmed: false });
        expect(placed([{ type: "confirmed" }], pending)).toMatchObject({ normalConfirmed: true, rareConfirmed: true });
    });

    it("reports only changes that alter what native capture delivers", () => {
        expect(captureSelectionChanged(confirmed, placed([{ type: "select", kind: "rare" }], confirmed))).toBe(false);
        expect(captureSelectionChanged(confirmed, placed([{ type: "move", region: region(0.4) }], confirmed))).toBe(
            true,
        );
        expect(captureSelectionChanged(confirmed, placed([{ type: "release" }], confirmed))).toBe(true);
    });
});
