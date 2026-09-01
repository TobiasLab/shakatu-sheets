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

export const SUPPORTED_LOOT_SOURCE = { width: 3440, height: 1440 } as const;
export const LOOT_REGION_SIZE = { width: 362, height: 311 } as const;

export function isSupportedLootSource(width: number, height: number): boolean {
    return width === SUPPORTED_LOOT_SOURCE.width && height === SUPPORTED_LOOT_SOURCE.height;
}

export function defaultLootRegion(): NormalizedRegion {
    return {
        x: 2433 / SUPPORTED_LOOT_SOURCE.width,
        y: 990 / SUPPORTED_LOOT_SOURCE.height,
        width: LOOT_REGION_SIZE.width / SUPPORTED_LOOT_SOURCE.width,
        height: LOOT_REGION_SIZE.height / SUPPORTED_LOOT_SOURCE.height,
    };
}

export function positionLootRegion(
    normalizedCenterX: number,
    normalizedCenterY: number,
    sourceWidth: number,
    sourceHeight: number,
): NormalizedRegion {
    if (!isSupportedLootSource(sourceWidth, sourceHeight)) {
        throw new Error("The selected source does not match the supported loot-recognition layout.");
    }
    const x = Math.max(
        0,
        Math.min(
            sourceWidth - LOOT_REGION_SIZE.width,
            Math.round(normalizedCenterX * sourceWidth - LOOT_REGION_SIZE.width / 2),
        ),
    );
    const y = Math.max(
        0,
        Math.min(
            sourceHeight - LOOT_REGION_SIZE.height,
            Math.round(normalizedCenterY * sourceHeight - LOOT_REGION_SIZE.height / 2),
        ),
    );
    return {
        x: x / sourceWidth,
        y: y / sourceHeight,
        width: LOOT_REGION_SIZE.width / sourceWidth,
        height: LOOT_REGION_SIZE.height / sourceHeight,
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
