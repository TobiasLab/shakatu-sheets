export const DISPLAY_CAPTURE_OPTIONS: DisplayMediaStreamOptions = {
    audio: false,
    video: true,
};

export type NormalizedRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type PixelRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type LootUiScale = 80 | 100;
export type LootRegionKind = "normal" | "rare";
export type LootAlignmentGuide = PixelRegion & { rowCenters: readonly number[] };

export const SUPPORTED_LOOT_SOURCES = [
    { width: 3440, height: 1440 },
    { width: 2560, height: 1440 },
    { width: 1920, height: 1080 },
] as const;
export const LOOT_REGION_SIZES: Record<LootUiScale, { width: number; height: number }> = {
    80: { width: 362, height: 311 },
    100: { width: 453, height: 389 },
};
export const RARE_LOOT_REGION_SIZES: Record<LootUiScale, { width: number; height: number }> = {
    80: { width: 400, height: 100 },
    100: { width: 500, height: 125 },
};
export const LOOT_SEARCH_REGION_SIZE = { width: 800, height: 600 } as const;
const DEFAULT_LOOT_CENTERS: Record<LootRegionKind, { x: number; y: number }> = {
    normal: { x: 2614 / 3440, y: 1145.5 / 1440 },
    rare: { x: 2300 / 3440, y: 870 / 1440 },
};
const BASE_ALIGNMENT_GUIDES: Record<
    LootRegionKind,
    { left: number; top: number; right: number; bottom: number; rowCenters: readonly number[] }
> = {
    normal: { left: 78, top: 36, right: 350, bottom: 216, rowCenters: [48, 87, 126, 165, 204] },
    rare: { left: 52, top: 20, right: 388, bottom: 92, rowCenters: [57] },
};

export function isSupportedLootSource(width: number, height: number): boolean {
    return SUPPORTED_LOOT_SOURCES.some((source) => source.width === width && source.height === height);
}

export function lootRegionSize(uiScalePercent: LootUiScale, kind: LootRegionKind = "normal") {
    return kind === "normal" ? LOOT_REGION_SIZES[uiScalePercent] : RARE_LOOT_REGION_SIZES[uiScalePercent];
}

export function lootAlignmentGuide(uiScalePercent: LootUiScale, kind: LootRegionKind = "normal"): LootAlignmentGuide {
    const base = BASE_ALIGNMENT_GUIDES[kind];
    const scale = uiScalePercent / 80;
    const x = Math.round(base.left * scale);
    const y = Math.round(base.top * scale);
    const right = Math.round(base.right * scale);
    const bottom = Math.round(base.bottom * scale);
    return {
        x,
        y,
        width: right - x,
        height: bottom - y,
        rowCenters: base.rowCenters.map((center) => Math.round(center * scale)),
    };
}

export function defaultLootRegion(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
    kind: LootRegionKind = "normal",
): NormalizedRegion {
    const center = DEFAULT_LOOT_CENTERS[kind];
    return positionLootRegion(center.x, center.y, sourceWidth, sourceHeight, uiScalePercent, kind);
}

export function positionLootRegion(
    normalizedCenterX: number,
    normalizedCenterY: number,
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
    kind: LootRegionKind = "normal",
): NormalizedRegion {
    if (!isSupportedLootSource(sourceWidth, sourceHeight)) {
        throw new Error("The selected source does not match the supported loot-recognition layout.");
    }
    const regionSize = lootRegionSize(uiScalePercent, kind);
    const x = Math.max(
        0,
        Math.min(sourceWidth - regionSize.width, Math.round(normalizedCenterX * sourceWidth - regionSize.width / 2)),
    );
    const y = Math.max(
        0,
        Math.min(
            sourceHeight - regionSize.height,
            Math.round(normalizedCenterY * sourceHeight - regionSize.height / 2),
        ),
    );
    return {
        x: x / sourceWidth,
        y: y / sourceHeight,
        width: regionSize.width / sourceWidth,
        height: regionSize.height / sourceHeight,
    };
}

export function positionLootSearchRegion(
    normalizedCenterX: number,
    normalizedCenterY: number,
    sourceWidth: number,
    sourceHeight: number,
): NormalizedRegion {
    if (!isSupportedLootSource(sourceWidth, sourceHeight)) {
        throw new Error("Automatic loot localization requires a supported source: 3440x1440, 2560x1440, or 1920x1080.");
    }
    if (![normalizedCenterX, normalizedCenterY].every(Number.isFinite)) {
        throw new Error("The search-region center is invalid.");
    }
    const x = Math.max(
        0,
        Math.min(sourceWidth - LOOT_SEARCH_REGION_SIZE.width, Math.round(normalizedCenterX * sourceWidth - 400)),
    );
    const y = Math.max(
        0,
        Math.min(sourceHeight - LOOT_SEARCH_REGION_SIZE.height, Math.round(normalizedCenterY * sourceHeight - 300)),
    );
    return pixelRegionToNormalized(
        { x, y, width: LOOT_SEARCH_REGION_SIZE.width, height: LOOT_SEARCH_REGION_SIZE.height },
        sourceWidth,
        sourceHeight,
    );
}

export function searchRegionAroundLootRegion(
    region: NormalizedRegion,
    sourceWidth: number,
    sourceHeight: number,
    kind: LootRegionKind = "normal",
    uiScalePercent: LootUiScale = 80,
): NormalizedRegion {
    const pixels = normalizedRegionToPixels(region, sourceWidth, sourceHeight);
    const expected = lootRegionSize(uiScalePercent, kind);
    if (pixels.width !== expected.width || pixels.height !== expected.height) {
        throw new Error(
            `Automatic loot localization requires an exact ${expected.width}x${expected.height} ${kind} loot region.`,
        );
    }
    return positionLootSearchRegion(
        (pixels.x + pixels.width / 2) / sourceWidth,
        (pixels.y + pixels.height / 2) / sourceHeight,
        sourceWidth,
        sourceHeight,
    );
}

export function nudgeLootRegion(
    region: NormalizedRegion,
    deltaX: number,
    deltaY: number,
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
    kind: LootRegionKind = "normal",
) {
    if (!Number.isSafeInteger(deltaX) || !Number.isSafeInteger(deltaY)) {
        throw new Error("Loot capture nudges must use whole source pixels.");
    }
    const pixels = normalizedRegionToPixels(region, sourceWidth, sourceHeight);
    const expected = lootRegionSize(uiScalePercent, kind);
    if (pixels.width !== expected.width || pixels.height !== expected.height) {
        throw new Error("The capture region does not match its configured loot area.");
    }
    return positionLootRegion(
        (pixels.x + pixels.width / 2 + deltaX) / sourceWidth,
        (pixels.y + pixels.height / 2 + deltaY) / sourceHeight,
        sourceWidth,
        sourceHeight,
        uiScalePercent,
        kind,
    );
}

function pixelBoundary(normalized: number, sourceSize: number, roundUp: boolean): number {
    const scaled = normalized * sourceSize;
    const nearest = Math.round(scaled);
    const tolerance = Number.EPSILON * Math.max(Math.abs(scaled), 1) * 4;
    const stable = Math.abs(scaled - nearest) <= tolerance ? nearest : scaled;
    return roundUp ? Math.ceil(stable) : Math.floor(stable);
}

export function normalizedRegionToPixels(
    region: NormalizedRegion,
    sourceWidth: number,
    sourceHeight: number,
): PixelRegion {
    const values = [region.x, region.y, region.width, region.height];
    if (
        !values.every(Number.isFinite) ||
        region.x < 0 ||
        region.y < 0 ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x + region.width > 1 ||
        region.y + region.height > 1 ||
        !Number.isInteger(sourceWidth) ||
        !Number.isInteger(sourceHeight) ||
        sourceWidth <= 0 ||
        sourceHeight <= 0
    ) {
        throw new Error("The capture region is invalid.");
    }
    const x = pixelBoundary(region.x, sourceWidth, false);
    const y = pixelBoundary(region.y, sourceHeight, false);
    const endX = Math.min(sourceWidth, pixelBoundary(region.x + region.width, sourceWidth, true));
    const endY = Math.min(sourceHeight, pixelBoundary(region.y + region.height, sourceHeight, true));
    if (x >= endX || y >= endY) throw new Error("The capture region is empty.");
    return { x, y, width: endX - x, height: endY - y };
}

export function pixelRegionToNormalized(
    region: PixelRegion,
    sourceWidth: number,
    sourceHeight: number,
): NormalizedRegion {
    const values = [region.x, region.y, region.width, region.height, sourceWidth, sourceHeight];
    if (
        !values.every(Number.isSafeInteger) ||
        region.x < 0 ||
        region.y < 0 ||
        region.width <= 0 ||
        region.height <= 0 ||
        sourceWidth <= 0 ||
        sourceHeight <= 0 ||
        region.x + region.width > sourceWidth ||
        region.y + region.height > sourceHeight
    ) {
        throw new Error("The pixel capture region is invalid.");
    }
    return {
        x: region.x / sourceWidth,
        y: region.y / sourceHeight,
        width: region.width / sourceWidth,
        height: region.height / sourceHeight,
    };
}

export function stopDisplayCapture(stream: MediaStream | null): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
}

export function displayCaptureErrorMessage(error: unknown): string {
    if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") return "Screen sharing was cancelled or denied by the system.";
        if (error.name === "NotFoundError") return "No monitor is available to share.";
        if (error.name === "NotReadableError") return "The selected monitor could not be read.";
        if (error.name === "AbortError") return "Screen sharing stopped before capture began.";
    }
    return error instanceof Error ? error.message : String(error);
}
