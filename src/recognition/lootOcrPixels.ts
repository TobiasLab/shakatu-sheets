import type { LootOcrBounds, LootRoiFrame } from "./liveLoot";
import type { LootOcrThreshold } from "./liveLootOcr";
import { chroma, luminance } from "./lootPixels";

/** Preserve antialiased text strokes before enlargement; binary masks can lose small digit shapes. */
export function writeAntialiasedLootPixels(
    frame: LootRoiFrame,
    bounds: LootOcrBounds,
    threshold: LootOcrThreshold,
    scale: 2 | 4,
    output: Uint8ClampedArray,
    outputWidth: number,
) {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const gray = new Uint8Array(width * height);
    const low = threshold - 70;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const sourceY = y + bounds.top;
            if (sourceY < 0 || sourceY >= frame.height) {
                gray[y * width + x] = 255;
                continue;
            }
            const offset = (sourceY * frame.width + x + bounds.left) * 4;
            const light = luminance(frame.pixels, offset);
            gray[y * width + x] =
                chroma(frame.pixels, offset) > 65
                    ? 255
                    : 255 - Math.max(0, Math.min(255, Math.round(((light - low) * 255) / (235 - low))));
        }
    }
    for (let y = 0; y < height * scale; y += 1) {
        const sourceY = Math.max(0, Math.min(height - 1, (y + 0.5) / scale - 0.5));
        const top = Math.floor(sourceY);
        const bottom = Math.min(top + 1, height - 1);
        const dy = sourceY - top;
        for (let x = 0; x < width * scale; x += 1) {
            const sourceX = Math.max(0, Math.min(width - 1, (x + 0.5) / scale - 0.5));
            const left = Math.floor(sourceX);
            const right = Math.min(left + 1, width - 1);
            const dx = sourceX - left;
            const value = Math.round(
                (gray[top * width + left] * (1 - dx) + gray[top * width + right] * dx) * (1 - dy) +
                    (gray[bottom * width + left] * (1 - dx) + gray[bottom * width + right] * dx) * dy,
            );
            const offset = ((y + 10) * outputWidth + x + 10) * 4;
            output[offset] = value;
            output[offset + 1] = value;
            output[offset + 2] = value;
        }
    }
}
