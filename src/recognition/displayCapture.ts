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

export const SUPPORTED_LOOT_SOURCES = [
    { width: 3440, height: 1440 },
    { width: 2560, height: 1440 },
    { width: 1920, height: 1080 },
] as const;
export const LOOT_REGION_SIZES: Record<LootUiScale, { width: number; height: number }> = {
    80: { width: 362, height: 311 },
    100: { width: 453, height: 389 },
};
const DEFAULT_LOOT_CENTER = { x: 2614 / 3440, y: 1145.5 / 1440 } as const;

export function isSupportedLootSource(width: number, height: number): boolean {
    return SUPPORTED_LOOT_SOURCES.some((source) => source.width === width && source.height === height);
}

export function lootRegionSize(uiScalePercent: LootUiScale) {
    return LOOT_REGION_SIZES[uiScalePercent];
}

export function defaultLootRegion(
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): NormalizedRegion {
    return positionLootRegion(DEFAULT_LOOT_CENTER.x, DEFAULT_LOOT_CENTER.y, sourceWidth, sourceHeight, uiScalePercent);
}

export function positionLootRegion(
    normalizedCenterX: number,
    normalizedCenterY: number,
    sourceWidth: number,
    sourceHeight: number,
    uiScalePercent: LootUiScale,
): NormalizedRegion {
    if (!isSupportedLootSource(sourceWidth, sourceHeight)) {
        throw new Error("The selected source does not match the supported loot-recognition layout.");
    }
    const regionSize = lootRegionSize(uiScalePercent);
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
