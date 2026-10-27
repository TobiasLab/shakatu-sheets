import type { LootRegionKind, LootUiScale, NormalizedRegion } from "../../recognition/displayCapture";

export type PlacementMode = "localizing" | "aligned" | "manual";

/**
 * Where the loot stack and rare banner areas are and whether recognition may use them. `normalCaptureRegion` and
 * `rareCaptureRegion` are the crops native capture delivers; an area being searched for has none. A rare-banner search
 * pauses the loot stack only because capture switches to the search crop, so `afterSearch` holds the loot stack
 * placement to restore when the search ends.
 */
export type CapturePlacement = {
    mode: PlacementMode;
    activeKind: LootRegionKind;
    uiScale: LootUiScale;
    normalRegion: NormalizedRegion | null;
    rareRegion: NormalizedRegion | null;
    normalCaptureRegion: NormalizedRegion | null;
    rareCaptureRegion: NormalizedRegion | null;
    searchRegion: NormalizedRegion | null;
    normalConfirmed: boolean;
    rareConfirmed: boolean;
    afterSearch: { mode: "manual" | "aligned"; confirmed: boolean };
};

export type PlacementAction =
    /** Capture stopped: forget both areas. */
    | { type: "release" }
    /** A new capture source: start from the given (saved or default) areas, or none for an unsupported source. */
    | {
          type: "configure";
          uiScale: LootUiScale;
          normalRegion: NormalizedRegion | null;
          rareRegion: NormalizedRegion | null;
          normalConfirmed: boolean;
          rareConfirmed: boolean;
      }
    | { type: "select"; kind: LootRegionKind }
    /** The user placed the selected area by dragging, nudging, or resetting it. */
    | { type: "move"; region: NormalizedRegion }
    /** While searching, the user dragged the search area; `region` is the area the search starts from. */
    | { type: "move-search"; region: NormalizedRegion; searchRegion: NormalizedRegion }
    /** `regions` holds both areas repositioned for the new scale, or null when the source cannot be placed. */
    | { type: "scale"; uiScale: LootUiScale; regions: { normal: NormalizedRegion; rare: NormalizedRegion } | null }
    | { type: "begin-search"; searchRegion: NormalizedRegion }
    /** The search was cancelled or failed. */
    | { type: "end-search" }
    /** The search found the selected area. `defaultRare` places the rare area if it has never been placed. */
    | { type: "lock-search"; region: NormalizedRegion; defaultRare: NormalizedRegion }
    /** Areas read from the game's saved layout; an area the layout lacks is null and keeps its placement. */
    | { type: "import-layout"; normal: NormalizedRegion | null; rare: NormalizedRegion | null }
    /** Confirming starts capturing both areas as placed; `confirmed` follows once the placement is saved. */
    | { type: "confirm" }
    | { type: "confirmed" }
    /** The source changed size under a Windows window capture, so the saved placement no longer applies. */
    | { type: "unconfirm" };

export const initialCapturePlacement: CapturePlacement = {
    mode: "manual",
    activeKind: "normal",
    uiScale: 80,
    normalRegion: null,
    rareRegion: null,
    normalCaptureRegion: null,
    rareCaptureRegion: null,
    searchRegion: null,
    normalConfirmed: false,
    rareConfirmed: false,
    afterSearch: { mode: "manual", confirmed: false },
};

export function regionsEqual(left: NormalizedRegion | null, right: NormalizedRegion | null) {
    return (
        left === right ||
        (left !== null &&
            right !== null &&
            left.x === right.x &&
            left.y === right.y &&
            left.width === right.width &&
            left.height === right.height)
    );
}

export function placementRegion(placement: CapturePlacement, kind: LootRegionKind) {
    return kind === "normal" ? placement.normalRegion : placement.rareRegion;
}

/** The loot stack is aligned automatically or confirmed by the user. */
export function normalPlacementReady(placement: CapturePlacement) {
    return placement.mode === "aligned" || placement.normalConfirmed;
}

/** Whether the change alters what native capture must deliver. */
export function captureSelectionChanged(previous: CapturePlacement, next: CapturePlacement) {
    return (
        previous.mode !== next.mode ||
        previous.uiScale !== next.uiScale ||
        previous.rareConfirmed !== next.rareConfirmed ||
        !regionsEqual(previous.normalCaptureRegion, next.normalCaptureRegion) ||
        !regionsEqual(previous.rareCaptureRegion, next.rareCaptureRegion) ||
        !regionsEqual(previous.searchRegion, next.searchRegion)
    );
}

function withRegion(placement: CapturePlacement, kind: LootRegionKind, region: NormalizedRegion | null) {
    return kind === "normal" ? { ...placement, normalRegion: region } : { ...placement, rareRegion: region };
}

function withCaptureRegion(placement: CapturePlacement, kind: LootRegionKind, region: NormalizedRegion | null) {
    return kind === "normal"
        ? { ...placement, normalCaptureRegion: region }
        : { ...placement, rareCaptureRegion: region };
}

function restoredAfterSearch(placement: CapturePlacement): CapturePlacement {
    return {
        ...placement,
        searchRegion: null,
        mode: placement.afterSearch.mode,
        normalConfirmed: placement.afterSearch.confirmed,
    };
}

export function reducePlacement(placement: CapturePlacement, action: PlacementAction): CapturePlacement {
    switch (action.type) {
        case "release":
            return {
                ...placement,
                normalRegion: null,
                rareRegion: null,
                normalCaptureRegion: null,
                rareCaptureRegion: null,
                searchRegion: null,
                mode: "manual",
                normalConfirmed: false,
                rareConfirmed: false,
            };
        case "configure":
            return {
                ...placement,
                uiScale: action.uiScale,
                normalRegion: action.normalRegion,
                rareRegion: action.rareRegion,
                normalCaptureRegion: action.normalRegion,
                rareCaptureRegion: action.rareRegion,
                searchRegion: null,
                mode: "manual",
                normalConfirmed: action.normalConfirmed,
                rareConfirmed: action.rareConfirmed,
            };
        case "select":
            return { ...placement, activeKind: action.kind };
        case "move": {
            const kind = placement.activeKind;
            let next = placement;
            // Moving the rare area leaves the loot stack's placement and confirmation alone.
            if (kind === "rare") next = { ...next, rareConfirmed: false };
            else if (next.mode !== "localizing")
                next = { ...next, searchRegion: null, mode: "manual", normalConfirmed: false };
            return withCaptureRegion(withRegion(next, kind, action.region), kind, action.region);
        }
        case "move-search": {
            const kind = placement.activeKind;
            const next = { ...placement, searchRegion: action.searchRegion, normalConfirmed: false };
            return withCaptureRegion(withRegion(next, kind, action.region), kind, null);
        }
        case "scale":
            if (!action.regions)
                return { ...placement, uiScale: action.uiScale, normalConfirmed: false, rareConfirmed: false };
            return {
                ...placement,
                uiScale: action.uiScale,
                normalRegion: action.regions.normal,
                rareRegion: action.regions.rare,
                normalCaptureRegion: action.regions.normal,
                rareCaptureRegion: action.regions.rare,
                searchRegion: null,
                mode: "manual",
                normalConfirmed: false,
                rareConfirmed: false,
            };
        case "begin-search": {
            const kind = placement.activeKind;
            const afterSearch: CapturePlacement["afterSearch"] =
                kind === "rare"
                    ? {
                          mode: placement.mode === "aligned" ? "aligned" : "manual",
                          confirmed: placement.normalConfirmed,
                      }
                    : { mode: "manual", confirmed: false };
            return withCaptureRegion(
                {
                    ...placement,
                    afterSearch,
                    searchRegion: action.searchRegion,
                    mode: "localizing",
                    normalConfirmed: false,
                    rareConfirmed: kind === "rare" ? false : placement.rareConfirmed,
                },
                kind,
                null,
            );
        }
        case "end-search":
            return {
                ...restoredAfterSearch(placement),
                normalCaptureRegion: placement.normalRegion,
                rareCaptureRegion: placement.rareRegion,
            };
        case "lock-search": {
            if (placement.activeKind === "rare") {
                return {
                    ...restoredAfterSearch(placement),
                    rareRegion: action.region,
                    rareCaptureRegion: action.region,
                    rareConfirmed: false,
                };
            }
            const rareRegion = placement.rareRegion ?? action.defaultRare;
            return {
                ...placement,
                searchRegion: null,
                normalRegion: action.region,
                normalCaptureRegion: action.region,
                mode: "aligned",
                normalConfirmed: false,
                activeKind: placement.rareConfirmed ? placement.activeKind : "rare",
                rareRegion,
                rareCaptureRegion: rareRegion,
            };
        }
        case "import-layout": {
            const normalRegion = action.normal ?? placement.normalRegion;
            const rareRegion = action.rare ?? placement.rareRegion;
            return {
                ...placement,
                searchRegion: null,
                mode: "manual",
                activeKind: action.normal ? "normal" : "rare",
                normalRegion,
                rareRegion,
                normalCaptureRegion: normalRegion,
                rareCaptureRegion: rareRegion,
                normalConfirmed: false,
                rareConfirmed: action.rare ? false : placement.rareConfirmed,
            };
        }
        case "confirm":
            return {
                ...placement,
                normalCaptureRegion: placement.normalRegion,
                rareCaptureRegion: placement.rareRegion,
            };
        case "confirmed":
            return { ...placement, normalConfirmed: true, rareConfirmed: true };
        case "unconfirm":
            return { ...placement, normalConfirmed: false, rareConfirmed: false };
        default:
            return placement;
    }
}
