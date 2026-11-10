import { normalLootColumn } from "./displayCapture";
import type { LootDetectionProfile, LootRoiFrame } from "./liveLoot";
import type { LootFont } from "./lootFont";
import { chroma, luminance } from "./lootPixels";

/**
 * Luminance of fully opaque loot text at 3440x1440 and 80% UI scale. Korean is measured on the recordings the ledger
 * was checked against. Strong Sword is measured on a recording the ledger has not been replayed on.
 */
export const LOOT_TEXT_LUMINANCE: Record<LootFont, number> = { korean: 228, "strong-sword": 218 };

// Opacity thresholds, from 132,000 frames of Korean recordings at 16 FPS. A fully shown row reads about 0.99. Its
// first fading frame reads 0.67 to 0.90, and each later frame up to 0.30 less. A slot without a row reads under 0.4
// in all but one frame in a thousand.
const BRIGHT = 0.93;
const FADING = 0.5;
/** The least a row reads on its first fading frame. Dimmer entries next to the fully shown rows are scenery. */
const FRESH_FADE = 0.6;
/** How much brighter than a frame earlier a fading row may read through noise. */
const BRIGHTENING_TOLERANCE = 0.03;
const MAXIMUM_FADE_STEP = 0.35;
/**
 * How long a difference must last to be reported, in case the two counters date the same drop a few frames apart. In
 * the recordings they never did: every drop both saw has the same frame in both.
 */
const PERSISTENCE_FRAMES = 12;
/**
 * The tracker confirms a drop with the following frame, and the ledger sees each frame before the tracker does. The
 * tracker's count for a frame is therefore known once the ledger is two frames further.
 */
const SETTLE_DELAY_FRAMES = 2;

/**
 * How opaque each row slot's text is, top slot first: about 1 while a row is fully shown and falling as it fades.
 * Each column compares its brightest unsaturated pixel with the column's own background, so how bright the scenery
 * behind a row is does not change the reading. Scenery with contrast of its own can still raise a slot. NaN means too
 * little of the slot had a background dark enough to measure against.
 */
export function lootRowOpacities(frame: LootRoiFrame, profile: LootDetectionProfile, textLuminance: number) {
    const scale = profile.pixelScale ?? 1;
    // The start of the item name, which every row has.
    const left = normalLootColumn(frame.width, 0.27);
    const right = normalLootColumn(frame.width, 0.55);
    const halfBand = Math.round(6 * scale);
    const column = new Uint8Array(2 * halfBand + 1);
    return Array.from({ length: profile.maxRows }, (_, slot) => {
        const center = profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing;
        const opacities: number[] = [];
        for (let x = left; x < right; x++) {
            let peak = 0;
            for (let y = center - halfBand; y <= center + halfBand; y++) {
                const offset = (y * frame.width + x) * 4;
                const value = luminance(frame.pixels, offset);
                column[y - center + halfBand] = value;
                // The chroma limit `isGlyphPixel` puts on loot text; brighter saturated pixels are scenery.
                if (value > peak && chroma(frame.pixels, offset) <= 55) peak = value;
            }
            column.sort();
            // Text covers the smaller part of a column, so the lower quartile is background.
            const background = column[column.length >> 2];
            // Too close to the text's own luminance for the ratio to mean anything.
            if (textLuminance - background < 40) continue;
            opacities.push(Math.max(0, peak - background) / (textLuminance - background));
        }
        if (opacities.length < (right - left) * 0.6) return Number.NaN;
        opacities.sort((a, b) => a - b);
        // Columns between glyph strokes read 0, so the slot is as opaque as its strongest third of columns.
        return opacities[Math.floor(opacities.length * 0.7)];
    });
}

/** A drop one counter saw and the other did not, reported once the difference has lasted. */
export type LootLedgerEvent = {
    /** `missed`: brightness shows an arrival the tracker did not count. `phantom`: the tracker counted one without it. */
    kind: "missed" | "phantom";
    /** The frame the difference appeared in. */
    frame: number;
    count: number;
};

type Staircase = { bright: number; fading: number[] };

/**
 * How many rows of `current` started fading: the youngest ones, below the rows that continue from `previous`.
 * A continuing row keeps its opacity or loses a plausible step. Entries above the continuing rows that match
 * nothing are scenery.
 */
function startedFading(previous: Staircase, current: Staircase) {
    for (let ignored = 0; ignored <= current.fading.length; ignored++) {
        const rows = current.fading.length - ignored;
        for (let vanished = 0; vanished <= previous.fading.length; vanished++) {
            const continuing = previous.fading.length - vanished;
            const started = rows - continuing;
            if (started < 0 || started > previous.bright) continue;
            let consistent = true;
            for (let index = 0; index < continuing && consistent; index++) {
                const step = previous.fading[index] - current.fading[started + index];
                consistent = step >= -BRIGHTENING_TOLERANCE && step <= MAXIMUM_FADE_STEP;
            }
            for (let index = 0; index < started && consistent; index++) {
                consistent = current.fading[index] >= FRESH_FADE;
            }
            if (consistent) return started;
        }
    }
    return 0;
}

/**
 * Counts loot arrivals from row brightness alone and compares them with the tracker's count.
 *
 * A new row appears fully opaque, and rows fade in the order they arrived. Each frame is therefore a staircase of
 * fully shown rows at the bottom with fading rows above, and
 *
 *     arrivals = change in fully shown rows + rows that started fading.
 *
 * No text is compared and no lifetime is assumed, so identical drops and stretched lifetimes do not matter. Where the
 * ledger cannot see an arrival it trusts the tracker: while every slot holds a fully shown row, and across frames it
 * could not measure. A difference in the last second before capture ends is not reported.
 */
export class LootBrightnessLedger {
    private previous: Staircase | undefined;
    /** Whether the frame before the next one could not be measured. True at the start, when there is none. */
    private unmeasured = true;
    private settled = 0;
    /** Tracker counts from frames that could not be measured, held for the next frame that can. */
    private carried = 0;
    private readonly arrivals = new Map<number, number>();
    private readonly counts = new Map<number, number>();
    private readonly blind = new Set<number>();
    /** Rows one counter has and the other lacks, oldest first. They are all of one kind. */
    private readonly open: { kind: LootLedgerEvent["kind"]; frame: number }[] = [];
    private readonly events: LootLedgerEvent[] = [];

    /**
     * Takes the frame the tracker is about to see as number `frame`. `opacities` come from `lootRowOpacities`;
     * `detectedRows` is how many bottom rows the row detector found.
     */
    push(frame: number, opacities: readonly number[], detectedRows: number) {
        const current = this.staircase(opacities, detectedRows);
        if (current) {
            // The last measured staircase is kept across unmeasured frames, so arrivals during them count here.
            const previous = this.previous;
            this.arrivals.set(
                frame,
                previous ? Math.max(0, current.bright - previous.bright + startedFading(previous, current)) : 0,
            );
            // An arrival into a full stack changes nothing, and a row can arrive and fade out between measured frames.
            const full = opacities.length;
            if (this.unmeasured || current.bright === full || previous?.bright === full) this.blind.add(frame);
            this.previous = current;
        }
        this.unmeasured = !current;
        while (this.settled <= frame - SETTLE_DELAY_FRAMES) this.settle(this.settled++);
    }

    /** Records that the tracker counted a new drop that first appeared in `frame`. */
    counted(frame: number) {
        // A count dated before the frames still open is compared with the oldest of them rather than lost.
        const open = Math.max(frame, this.settled);
        this.counts.set(open, (this.counts.get(open) ?? 0) + 1);
    }

    takeEvents() {
        return this.events.splice(0);
    }

    private staircase(opacities: readonly number[], detectedRows: number): Staircase | undefined {
        const bottom = opacities.length - 1;
        let bright = 0;
        // Scenery can be as contrasty as text, so a fully shown row must also be one the row detector found.
        while (bright < detectedRows && opacities[bottom - bright] >= BRIGHT) bright++;
        const fading: number[] = [];
        for (let slot = bottom - bright; slot >= 0; slot--) {
            const opacity = opacities[slot];
            if (Number.isNaN(opacity)) return undefined;
            if (opacity < FADING || opacity >= BRIGHT) break;
            fading.push(opacity);
        }
        return { bright, fading };
    }

    private settle(frame: number) {
        const counted = this.carried + (this.counts.get(frame) ?? 0);
        const arrivals = this.arrivals.get(frame);
        this.counts.delete(frame);
        this.carried = arrivals === undefined ? counted : 0;
        if (arrivals !== undefined) {
            let difference = arrivals - counted;
            if (difference < 0 && this.blind.has(frame)) difference = 0;
            this.arrivals.delete(frame);
            this.blind.delete(frame);
            const kind = difference > 0 ? "missed" : "phantom";
            for (let rows = Math.abs(difference); rows > 0; rows--) {
                // A drop the counters date differently is one difference of each kind; the later cancels the earlier.
                if (this.open.length > 0 && this.open[this.open.length - 1].kind !== kind) this.open.pop();
                else this.open.push({ kind, frame });
            }
        }
        for (let oldest = this.open[0]; oldest && frame - oldest.frame >= PERSISTENCE_FRAMES; oldest = this.open[0]) {
            this.open.shift();
            const last = this.events[this.events.length - 1];
            if (last?.kind === oldest.kind && last.frame === oldest.frame) last.count += 1;
            else this.events.push({ ...oldest, count: 1 });
        }
    }
}
