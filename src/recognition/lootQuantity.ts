import type { LootOcrBounds, LootRoiFrame } from "./liveLoot";

export type LootQuantityGlyphs = {
    bounds: LootOcrBounds;
    pixels: Uint8Array;
};

/** Locate the final word after a small, isolated quantity marker. Coordinates come from this row's text. */
export function locateLootQuantity(
    frame: LootRoiFrame,
    centerY: number,
    projection: Uint8Array,
    scale: number,
): LootQuantityGlyphs | undefined {
    const gap = Math.round(8 * scale);
    const wordGap = Math.ceil(4.5 * scale);
    const origin = Math.round(frame.width * 0.27);
    const words: Array<{ left: number; right: number }> = [];
    let start = -1;
    let end = -1;
    for (let x = 0; x < projection.length; x += 1) {
        if (projection[x]) {
            if (start < 0) start = x;
            end = x + 1;
        } else if (end >= 0) {
            const space = x + 1 - end;
            if (space === wordGap && start >= 0) {
                words.push({ left: start + origin, right: end + origin });
                start = -1;
            }
            if (space >= gap) break;
        }
    }
    // A clipped suffix has no trailing whitespace and is not safe to compare or OCR separately.
    if (start >= 0 || words.length < 3) return undefined;
    const digits = words[words.length - 1];
    const marker = words[words.length - 2];
    const markerWidth = marker.right - marker.left;
    if (markerWidth < 4 * scale || markerWidth > 8 * scale || digits.right - digits.left > 48 * scale) return undefined;
    const halfHeight = Math.round(8 * scale);
    const bounds = {
        left: digits.left - 1,
        right: digits.right + 1,
        top: centerY - halfHeight,
        bottom: centerY + halfHeight,
    };
    if (bounds.left < 0 || bounds.right > frame.width || bounds.top < 0 || bounds.bottom > frame.height)
        return undefined;
    const width = bounds.right - bounds.left;
    const pixels = new Uint8Array(width * (bounds.bottom - bounds.top));
    let ink = 0;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
        for (let x = bounds.left; x < bounds.right; x += 1) {
            const offset = (y * frame.width + x) * 4;
            const red = frame.pixels[offset];
            const green = frame.pixels[offset + 1];
            const blue = frame.pixels[offset + 2];
            if (
                (red * 77 + green * 150 + blue * 29) >> 8 < 150 ||
                Math.max(red, green, blue) - Math.min(red, green, blue) > 65
            )
                continue;
            pixels[(y - bounds.top) * width + x - bounds.left] = 1;
            ink += 1;
        }
    }
    return ink >= 6 * scale * scale ? { bounds, pixels } : undefined;
}

/** Keep all ink in the denominator, including strokes outside the aligned overlap. */
export function lootQuantityDistance(left: LootQuantityGlyphs, right: LootQuantityGlyphs): number {
    const leftWidth = left.bounds.right - left.bounds.left;
    const rightWidth = right.bounds.right - right.bounds.left;
    const height = left.bounds.bottom - left.bounds.top;
    if (height !== right.bounds.bottom - right.bounds.top) return 1;
    const leftInk = left.pixels.reduce((sum, pixel) => sum + pixel, 0);
    const rightInk = right.pixels.reduce((sum, pixel) => sum + pixel, 0);
    if (!leftInk || !rightInk) return 1;
    let intersection = 0;
    for (let shift = -1; shift <= 1; shift += 1) {
        let overlap = 0;
        for (let y = 0; y < height; y += 1) {
            if (y + shift < 0 || y + shift >= height) continue;
            for (let x = 0; x < leftWidth; x += 1) {
                const otherX = x + left.bounds.left - right.bounds.left;
                if (otherX >= 0 && otherX < rightWidth)
                    overlap += left.pixels[y * leftWidth + x] * right.pixels[(y + shift) * rightWidth + otherX];
            }
        }
        intersection = Math.max(intersection, overlap);
    }
    return 1 - intersection / Math.sqrt(leftInk * rightInk);
}
