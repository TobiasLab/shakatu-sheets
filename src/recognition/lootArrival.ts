import { normalLootColumn } from "./displayCapture";
import type { LootDetectedRows, LootDetectionProfile, LootRoiFrame } from "./liveLoot";
import { chroma, luminance } from "./lootPixels";

export type LootRowAppearance = { contrast: Uint16Array; visibility: number };

/** Keep faint glyph edges for arrival evidence; these rows are not eligible for OCR by themselves. */
export function lootRowAppearances(frame: LootRoiFrame, profile: LootDetectionProfile): LootRowAppearance[] {
    const scale = profile.pixelScale ?? 1;
    const left = normalLootColumn(frame.width, 0.27);
    const right = normalLootColumn(frame.width, 0.55);
    const halfBand = Math.round(6 * scale);
    const step = Math.round(2 * scale) * 4;
    return Array.from({ length: profile.maxRows }, (_, slot) => {
        const center = profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing;
        const contrast = new Uint16Array(right - left);
        const peaks = new Uint8Array(right - left);
        for (let x = left; x < right; x++) {
            for (let y = center - halfBand; y <= center + halfBand; y++) {
                const offset = (y * frame.width + x) * 4;
                if (chroma(frame.pixels, offset) > 55) continue;
                const value = luminance(frame.pixels, offset);
                const background = Math.min(
                    luminance(frame.pixels, offset - step),
                    luminance(frame.pixels, offset + step),
                    luminance(frame.pixels, offset - frame.width * step),
                    luminance(frame.pixels, offset + frame.width * step),
                );
                contrast[x - left] += Math.max(0, value - background - 12);
                peaks[x - left] = Math.max(peaks[x - left], value);
            }
        }
        peaks.sort();
        return { contrast, visibility: peaks[Math.floor(peaks.length * 0.7)] };
    });
}

function appearanceDistance(left: LootRowAppearance, right: LootRowAppearance) {
    let product = 0;
    let leftSquared = 0;
    let rightSquared = 0;
    for (let index = 0; index < left.contrast.length; index++) {
        const a = left.contrast[index];
        const b = right.contrast[index];
        product += a * b;
        leftSquared += a * a;
        rightSquared += b * b;
    }
    return leftSquared && rightSquared ? 1 - product / Math.sqrt(leftSquared * rightSquared) : 1;
}

/** Require displaced, fading old text and persistent fresh bottom rows, not brightness alone. */
export function fadingLootArrivals<T>(
    previous: LootDetectedRows<T>,
    current: LootDetectedRows<T>,
    next: LootDetectedRows<T> | undefined,
): number {
    const before = previous.appearances;
    const now = current.appearances;
    const after = next?.appearances;
    if (!before || !now || !after || !previous.count || !current.count || !next?.count) return 0;
    const size = before.length;
    let first = size - previous.count;
    const fresh = Math.max(...before.slice(first).map((row) => row.visibility));
    if (!fresh) return 0;
    // A row can remain visible after falling below the normal detector threshold. Include it in displacement.
    while (
        first > 0 &&
        before[first - 1].visibility >= fresh * 0.25 &&
        appearanceDistance(before[first - 1], before[first]) <= 0.02
    )
        first--;
    for (let shift = 1; shift <= Math.min(size - 1, current.count); shift++) {
        let displaced = false;
        let compatible = true;
        for (let source = first; source < size; source++) {
            const target = source - shift;
            if (target < 0) continue;
            const old = before[source];
            const moved = now[target];
            const difference = appearanceDistance(old, moved);
            if (moved.visibility < fresh * 0.25 || (difference > 0.02 && moved.visibility < old.visibility * 0.75)) {
                if (old.visibility >= fresh * 0.85) {
                    compatible = false;
                    break;
                }
                continue;
            }
            if (moved.visibility > old.visibility * 1.1 || difference > 0.02) {
                compatible = false;
                break;
            }
            if (moved.visibility <= fresh * 0.9 && appearanceDistance(before[target], moved) >= 0.08) displaced = true;
        }
        // Prefer the smallest displacement supported by the pixels when identical rows permit several alignments.
        if (compatible && displaced && persistentBottom(shift)) return shift;
    }
    // A faint copy above a refreshed bottom row also establishes a single replacement when row count stays flat.
    const bottom = size - 1;
    if (
        current.count === previous.count &&
        size > 1 &&
        now[bottom].visibility - before[bottom].visibility >= 30 &&
        before[bottom].visibility < now[bottom].visibility * 0.86 &&
        now[bottom - 1].visibility < before[bottom].visibility * 0.85 &&
        now[bottom - 1].visibility >= fresh * 0.25 &&
        now[bottom - 1].visibility <= before[bottom - 1].visibility + 6 &&
        appearanceDistance(before[bottom], now[bottom - 1]) <= 0.02 &&
        persistentBottom(1)
    )
        return 1;
    return 0;

    function persistentBottom(count: number) {
        if (!now || !after || !next || next.count < count) return false;
        const added = now.slice(size - count);
        if (added.some((row) => row.visibility < fresh * 0.9)) return false;
        for (let offset = size - next.count; offset <= size - count; offset++) {
            if (
                added.every(
                    (row, index) =>
                        after[offset + index].visibility >= row.visibility * 0.9 &&
                        appearanceDistance(row, after[offset + index]) <= 0.02,
                )
            )
                return true;
        }
        return false;
    }
}

/** When only the top fades away, the surviving bottom rows keep their event identities. */
export function lootRowsFaded<T>(previous: LootDetectedRows<T>, current: LootDetectedRows<T>) {
    const before = previous.appearances;
    const now = current.appearances;
    if (!before || !now || !current.count || current.count >= previous.count) return false;
    const first = before.length - previous.count;
    const retained = before.length - current.count;
    return (
        before.slice(first, retained).every((row, index) => now[first + index].visibility < row.visibility * 0.85) &&
        before.slice(retained).every((row, index) => {
            const survivor = now[retained + index];
            return survivor.visibility <= row.visibility * 1.1 && appearanceDistance(row, survivor) <= 0.02;
        })
    );
}
