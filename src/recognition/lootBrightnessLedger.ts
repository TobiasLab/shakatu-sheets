import { normalLootColumn } from "./displayCapture";
import type { LootDetectionProfile, LootRoiFrame } from "./liveLoot";
import type { LootFont } from "./lootFont";
import { chroma, luminance } from "./lootPixels";

/**
 * Luminance of fully opaque loot text at 3440x1440 and 80% UI scale. Korean is measured on the recordings the ledger
 * was checked against. Strong Sword is measured on a recording the ledger has not been replayed on.
 */
export const LOOT_TEXT_LUMINANCE: Record<LootFont, number> = { korean: 228, "strong-sword": 218 };

/** Whether the ledger was checked on recordings in `font`, so that it may correct the tracker's count. */
export function ledgerCorrectsArrivals(font: LootFont) {
    return font === "korean";
}

// Opacity thresholds, from 132,000 frames of Korean recordings at 16 FPS. A fully shown row reads about 0.99. Its
// first fading frame reads 0.67 to 0.90, and each later frame up to 0.30 less, so it fades out of sight only from
// below 0.85. A slot without a row reads under 0.4 in all but one frame in a thousand.
const BRIGHT = 0.93;
const FADING = 0.5;
/** The least a row reads on its first fading frame. Dimmer entries next to the fully shown rows are scenery. */
const FRESH_FADE = 0.6;
/** How much brighter than a frame earlier a fading row may read through noise. */
const BRIGHTENING_TOLERANCE = 0.03;
const MAXIMUM_FADE_STEP = 0.35;
/** How far apart rows that start fading in the same frame may read. Only rows that arrived together do that. */
const TOGETHER_FADE_SPREAD = 0.1;
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

/** A measured frame. Rows sit at the bottom of the list: fully shown ones first, then fading ones above them. */
type Stack = {
    /** Opacity of each slot, bottom slot first. */
    opacities: number[];
    /** Fully shown rows at the bottom, each also found by the row detector. Only these can be new. */
    bright: number;
    /** Rows from the bottom up to the first slot that is neither fully shown nor fading, found by the detector or not. */
    rows: number;
};

/**
 * How badly "`arrived` rows arrived" explains `current`. Every row of `previous` moves up that many slots, or out of
 * the list, and keeps its brightness, starts to fade or fades on; the new rows below it are fully shown. An impossible
 * change outweighs any number of rows left unexplained, which may be scenery.
 */
function shiftCost(previous: Stack, current: Stack, arrived: number) {
    const slots = current.opacities.length;
    let impossible = 0;
    let explained = arrived;
    let dimmestStart = Number.POSITIVE_INFINITY;
    let brightestStart = 0;
    for (let row = 0; row < previous.rows && row + arrived < slots; row++) {
        const before = previous.opacities[row];
        const after = current.opacities[row + arrived];
        if (row < previous.bright) {
            if (after < FRESH_FADE) impossible++;
            if (after < BRIGHT) {
                dimmestStart = Math.min(dimmestStart, after);
                brightestStart = Math.max(brightestStart, after);
            }
        } else if (before - Math.max(after, FADING) > MAXIMUM_FADE_STEP) {
            // Too fast a fade, even for a row that faded out of sight.
            impossible++;
        } else if (after < FADING) {
            continue;
        } else if (after - before > BRIGHTENING_TOLERANCE) {
            impossible++;
        }
        explained = row + arrived + 1;
    }
    // Rows that start fading together arrived together, and fade alike.
    if (brightestStart - dimmestStart > TOGETHER_FADE_SPREAD) impossible++;
    // Rows above the ones explained may be scenery, but the fewer the better.
    const unexplained = Math.max(0, current.rows - explained);
    return impossible * slots + unexplained;
}

/** The fewest and most arrivals that explain `current` best. They differ when the frames cannot tell them apart. */
function arrivalRange(previous: Stack, current: Stack) {
    let best = Number.POSITIVE_INFINITY;
    let low = 0;
    let high = 0;
    for (let arrived = 0; arrived <= current.bright; arrived++) {
        const cost = shiftCost(previous, current, arrived);
        if (cost < best) {
            best = cost;
            low = arrived;
            high = arrived;
        } else if (cost === best) {
            high = arrived;
        }
    }
    return { low, high };
}

/**
 * Counts loot arrivals from row brightness alone and compares them with the tracker's count.
 *
 * A new row appears fully opaque at the bottom and pushes every row up a slot, and rows fade in the order they
 * arrived. Between two frames the ledger therefore tries each number of arrivals and keeps the ones that put every
 * row in the right slot with a brightness it could have. No text is compared and no lifetime is assumed, so identical
 * drops and stretched lifetimes do not matter.
 *
 * Where several numbers of arrivals explain a frame equally well, any of them agrees with the tracker; for example,
 * while every slot holds a fully shown row an arrival changes nothing. Across frames it could not measure, the ledger
 * only checks that the tracker counted at least the arrivals it saw. A difference in the last second before capture
 * ends is not reported.
 */
export class LootBrightnessLedger {
    private previous: Stack | undefined;
    /** Whether the frame before the next one could not be measured. True at the start, when there is none. */
    private unmeasured = true;
    private settled = 0;
    /** Tracker counts from frames that could not be measured, held for the next frame that can. */
    private carried = 0;
    private readonly arrivals = new Map<number, { low: number; high: number }>();
    private readonly counts = new Map<number, number>();
    /** Rows one counter has and the other lacks, oldest first. They are all of one kind. */
    private readonly open: { kind: LootLedgerEvent["kind"]; frame: number }[] = [];
    private readonly events: LootLedgerEvent[] = [];

    /**
     * Takes the frame the tracker is about to see as number `frame`. `opacities` come from `lootRowOpacities`;
     * `detectedRows` is how many bottom rows the row detector found.
     */
    push(frame: number, opacities: readonly number[], detectedRows: number) {
        const current = this.stack(opacities, detectedRows);
        if (current) {
            // The last measured frame is kept across unmeasured ones, so arrivals during them count here.
            const range = this.previous ? arrivalRange(this.previous, current) : { low: 0, high: 0 };
            // A row can arrive and fade out between measured frames.
            if (this.unmeasured) range.high = Number.POSITIVE_INFINITY;
            this.arrivals.set(frame, range);
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

    /**
     * The fewest and most rows that can have arrived in `frame`, once it was pushed and until it settles. Undefined for
     * a frame that could not be measured.
     */
    arrivalBounds(frame: number) {
        const range = this.arrivals.get(frame);
        return range && { ...range };
    }

    takeEvents() {
        return this.events.splice(0);
    }

    private stack(opacities: readonly number[], detectedRows: number): Stack | undefined {
        // Slots above the rows are compared too: rows fade out of sight there.
        if (opacities.some(Number.isNaN)) return undefined;
        const bottomFirst = [...opacities].reverse();
        let bright = 0;
        // Scenery can be as contrasty as text, so a fully shown row must also be one the row detector found.
        while (bright < detectedRows && bottomFirst[bright] >= BRIGHT) bright++;
        let rows = bright;
        // A row the detector lost for a frame is still a row, and not new when the detector finds it again.
        while (rows < bottomFirst.length && bottomFirst[rows] >= FADING) rows++;
        return { opacities: bottomFirst, bright, rows };
    }

    private settle(frame: number) {
        const counted = this.carried + (this.counts.get(frame) ?? 0);
        const range = this.arrivals.get(frame);
        this.counts.delete(frame);
        this.carried = range === undefined ? counted : 0;
        if (range !== undefined) {
            this.arrivals.delete(frame);
            // Any count within the arrivals the frames allow agrees.
            const difference = Math.min(Math.max(counted, range.low), range.high) - counted;
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
