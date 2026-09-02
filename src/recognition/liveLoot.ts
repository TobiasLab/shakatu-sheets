export type LootRoiFrame = {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
};

export type LootDetectionProfile = {
    width: number;
    height: number;
    maxRows: number;
    bottomCenter: number;
    spacing: number;
    rowThreshold: number;
};

export type LootFingerprint = {
    full: Uint8Array;
    quantity: Uint8Array;
};

export type LootRowObservation<TFingerprint = LootFingerprint> = {
    slot: number;
    centerY: number;
    score: number;
    fingerprint: TFingerprint;
};

export type LootDetectedRows<TFingerprint = LootFingerprint> = {
    count: number;
    strength: number;
    fingerprint?: TFingerprint;
    fingerprints: TFingerprint[];
    observations: LootRowObservation<TFingerprint>[];
};

export type LootTrack<TFingerprint = LootFingerprint> = {
    id: string;
    firstFrame: number;
    baseline: boolean;
    observations: Array<LootRowObservation<TFingerprint> & { frame: number }>;
};

export type LootRecognitionResult = {
    eventId: string;
    firstFrame: number;
    selectedFrames: number[];
    itemName: string | null;
    quantity: number | null;
};

type LiveLootEventResultBase = LootRecognitionResult & {
    status: "recognized" | "withheld" | "failed";
    reason: null | "insufficient-observations" | "consensus-withheld" | "ocr-failure";
};

export type LiveLootEventResult =
    | (LiveLootEventResultBase & {
          status: "recognized";
          reason: null;
          itemName: string;
          quantity: number;
      })
    | (LiveLootEventResultBase & {
          status: "withheld";
          reason: "insufficient-observations" | "consensus-withheld";
          itemName: null;
          quantity: null;
      })
    | (LiveLootEventResultBase & {
          status: "failed";
          reason: "ocr-failure";
          itemName: null;
          quantity: null;
      });

export type LiveLootOverflowSummary = {
    eventId: null;
    firstFrame: number;
    selectedFrames: [];
    itemName: null;
    quantity: null;
    status: "dropped";
    reason: "backpressure-summary" | "result-overflow-summary" | "mixed-overflow-summary";
    count: number;
    backpressureCount: number;
    resultOverflowCount: number;
    firstEventId: string;
    lastEventId: string;
    lastFrame: number;
};

export type LiveLootRecognitionResult = LiveLootEventResult | LiveLootOverflowSummary;

export type LiveLootOcrFrame = {
    frame: number;
    roi: LootRoiFrame;
    observation: LootRowObservation<LootFingerprint>;
};

export type LiveLootOcrReader = (
    frames: readonly LiveLootOcrFrame[],
    signal: AbortSignal,
) => Promise<readonly (readonly string[])[]>;

export type LiveLootCoordinatorOptions = {
    profile: LootDetectionProfile;
    dictionary: readonly string[];
    readText: LiveLootOcrReader;
    /** Must complete synchronously. Returned thenables are treated as callback errors and are not awaited. */
    onResult: (result: LiveLootRecognitionResult) => void;
    maxPendingOcrJobs?: number;
    maxPendingResults?: number;
    retainedFrameCount?: number;
};

export type FingerprintDistance<TFingerprint> = (
    left: TFingerprint | undefined,
    right: TFingerprint | undefined,
) => number;

function validateProfile(profile: LootDetectionProfile) {
    if (
        ![profile.width, profile.height, profile.maxRows, profile.bottomCenter, profile.spacing].every(
            (value) => Number.isInteger(value) && value > 0,
        ) ||
        !Number.isFinite(profile.rowThreshold) ||
        profile.rowThreshold < 0
    ) {
        throw new Error("Loot detection profile values are invalid.");
    }
    const topCenter = profile.bottomCenter - (profile.maxRows - 1) * profile.spacing;
    if (topCenter < 9 || profile.bottomCenter > profile.height - 10) {
        throw new Error("Loot detection row geometry exceeds the ROI bounds.");
    }
}

function luminance(frame: LootRoiFrame, offset: number) {
    return (frame.pixels[offset] * 77 + frame.pixels[offset + 1] * 150 + frame.pixels[offset + 2] * 29) >> 8;
}

function isGlyphPixel(frame: LootRoiFrame, offset: number) {
    const { pixels, width } = frame;
    const light = luminance(frame, offset);
    const chroma =
        Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) -
        Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    const horizontal = Math.min(luminance(frame, offset - 8), luminance(frame, offset + 8));
    const vertical = Math.min(luminance(frame, offset - width * 8), luminance(frame, offset + width * 8));
    return light >= 115 && chroma <= 55 && light - Math.min(horizontal, vertical) >= 18;
}

function rowScore(frame: LootRoiFrame, centerY: number) {
    let score = 0;
    const left = Math.round(frame.width * 0.22);
    const right = Math.round(frame.width * 0.96);
    for (let y = centerY - 6; y <= centerY + 6; y += 1) {
        for (let x = left; x < right; x += 1) {
            if (isGlyphPixel(frame, (y * frame.width + x) * 4)) score += 1;
        }
    }
    return score;
}

function rowFingerprint(frame: LootRoiFrame, centerY: number): LootFingerprint {
    const left = Math.round(frame.width * 0.27);
    const right = Math.round(frame.width * 0.96);
    const quantityLeft = Math.round(frame.width * 0.58);

    function project(startX: number) {
        const projection = new Uint8Array(right - startX);
        for (let x = startX; x < right; x += 1) {
            let brightPixels = 0;
            for (let y = centerY - 9; y <= centerY + 9; y += 1) {
                const offset = (y * frame.width + x) * 4;
                const chroma =
                    Math.max(frame.pixels[offset], frame.pixels[offset + 1], frame.pixels[offset + 2]) -
                    Math.min(frame.pixels[offset], frame.pixels[offset + 1], frame.pixels[offset + 2]);
                if (luminance(frame, offset) >= 150 && chroma <= 40) brightPixels += 1;
            }
            projection[x - startX] = brightPixels;
        }
        return projection;
    }

    return { full: project(left), quantity: project(quantityLeft) };
}

export function analyzeLootRoiFrame(
    frame: LootRoiFrame,
    profile: LootDetectionProfile,
): LootDetectedRows<LootFingerprint> {
    validateProfile(profile);
    if (frame.width !== profile.width || frame.height !== profile.height) {
        throw new Error(`Loot ROI must be ${profile.width}x${profile.height} pixels.`);
    }
    if (frame.pixels.length !== frame.width * frame.height * 4) {
        throw new Error("Loot ROI pixels must be tightly packed RGBA data.");
    }

    const scores = Array.from({ length: profile.maxRows }, (_, slot) =>
        rowScore(frame, profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing),
    );
    const fingerprints = Array.from({ length: profile.maxRows }, (_, slot) =>
        rowFingerprint(frame, profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing),
    );
    const detected = scores.map((score) => score >= profile.rowThreshold);
    let count = 0;
    for (let slot = profile.maxRows - 1; slot >= 0 && detected[slot]; slot -= 1) count += 1;
    const observations: LootRowObservation<LootFingerprint>[] = [];
    for (let slot = profile.maxRows - count; slot < profile.maxRows; slot += 1) {
        observations.push({
            slot,
            centerY: profile.bottomCenter - (profile.maxRows - slot - 1) * profile.spacing,
            score: scores[slot],
            fingerprint: fingerprints[slot],
        });
    }

    return {
        count,
        strength: scores.slice(profile.maxRows - count).reduce((total, score) => total + score, 0),
        fingerprint: count === 0 ? undefined : fingerprints[profile.maxRows - 1],
        fingerprints: count === 0 ? [] : fingerprints.slice(profile.maxRows - count),
        observations,
    };
}

export function lootFingerprintDistance(left: LootFingerprint | undefined, right: LootFingerprint | undefined) {
    if (!left || !right) return 0;

    function cosineDistance(leftProjection: Uint8Array, rightProjection: Uint8Array) {
        if (leftProjection.length !== rightProjection.length) return 1;
        let dot = 0;
        let leftLength = 0;
        let rightLength = 0;
        for (let index = 0; index < leftProjection.length; index += 1) {
            dot += leftProjection[index] * rightProjection[index];
            leftLength += leftProjection[index] ** 2;
            rightLength += rightProjection[index] ** 2;
        }
        if (leftLength === 0 || rightLength === 0) return leftLength === rightLength ? 0 : 1;
        return 1 - dot / Math.sqrt(leftLength * rightLength);
    }

    return Math.max(cosineDistance(left.full, right.full), cosineDistance(left.quantity, right.quantity));
}

export function stackShifted<TFingerprint>(
    previous: TFingerprint[],
    current: TFingerprint[],
    distance: FingerprintDistance<TFingerprint>,
    minimumImprovement = 0.1,
) {
    if (previous.length !== current.length || current.length < 2) return false;
    let stationaryDistance = 0;
    let shiftedDistance = 0;
    for (let index = 0; index < current.length - 1; index += 1) {
        stationaryDistance += distance(current[index], previous[index]);
        shiftedDistance += distance(current[index], previous[index + 1]);
    }
    return (stationaryDistance - shiftedDistance) / (current.length - 1) >= minimumImprovement;
}

export function rowBirthCount<TFingerprint>(
    previous: LootDetectedRows<TFingerprint>,
    current: LootDetectedRows<TFingerprint>,
    next: LootDetectedRows<TFingerprint> | undefined,
    rowThreshold: number,
    distance: FingerprintDistance<TFingerprint>,
) {
    const additions = Math.max(0, current.count - previous.count);
    if (current.count === 0) return 0;
    const maximumContinuityDistance = 0.1;

    function alignmentDistance(
        source: LootDetectedRows<TFingerprint>,
        target: LootDetectedRows<TFingerprint>,
        retained: number,
    ) {
        let total = 0;
        const sourceOffset = source.fingerprints.length - retained;
        for (let index = 0; index < retained; index += 1) {
            total += distance(source.fingerprints[sourceOffset + index], target.fingerprints[index]);
        }
        return total / retained;
    }

    function alignmentIsDiscriminative(
        source: LootDetectedRows<TFingerprint>,
        target: LootDetectedRows<TFingerprint>,
        retained: number,
        candidateDistance: number,
        minimumImprovement = 0.1,
    ) {
        const intendedOffset = source.fingerprints.length - retained;
        for (let alternativeOffset = 0; alternativeOffset < intendedOffset; alternativeOffset += 1) {
            let total = 0;
            for (let index = 0; index < retained; index += 1) {
                total += distance(source.fingerprints[alternativeOffset + index], target.fingerprints[index]);
            }
            if (total / retained - candidateDistance <= minimumImprovement) return false;
        }
        return true;
    }

    function confirmedBirthCount(birthCount: number) {
        if (birthCount === 0 || !next || next.count < birthCount) return 0;
        if (additions > 0 && next.count >= current.count) return birthCount;
        const maximumRetained = Math.min(current.count, next.count);
        for (let retained = maximumRetained; retained >= birthCount; retained -= 1) {
            const candidateDistance = alignmentDistance(current, next, retained);
            if (
                candidateDistance <= maximumContinuityDistance &&
                alignmentIsDiscriminative(current, next, retained, candidateDistance, Number.EPSILON)
            ) {
                return birthCount;
            }
        }
        return 0;
    }

    if (previous.count === 0) return confirmedBirthCount(additions);
    const maximumRetained = Math.min(previous.count, current.count);
    const stationaryDistance = alignmentDistance(previous, current, maximumRetained);
    let retained = maximumRetained;
    let bestDistance = stationaryDistance;
    for (let candidate = maximumRetained - 1; candidate >= 1; candidate -= 1) {
        const candidateDistance = alignmentDistance(previous, current, candidate);
        if (
            candidateDistance <= maximumContinuityDistance &&
            candidateDistance < bestDistance &&
            alignmentIsDiscriminative(previous, current, candidate, candidateDistance)
        ) {
            retained = candidate;
            bestDistance = candidateDistance;
        }
    }
    const alignedBirths = current.count - retained;
    const averageStrength = current.strength / current.count;
    const strengthChange = current.strength - previous.strength;
    if (
        alignedBirths > additions &&
        stationaryDistance - bestDistance >= 0.1 &&
        averageStrength >= rowThreshold * 2 &&
        (current.count < previous.count || strengthChange >= -rowThreshold / 2)
    ) {
        return confirmedBirthCount(alignedBirths);
    }

    if (additions > 0) {
        let alternativeDistance = Number.POSITIVE_INFINITY;
        for (let offset = 1; offset <= additions; offset += 1) {
            let total = 0;
            for (let index = 0; index < previous.count; index += 1) {
                total += distance(previous.fingerprints[index], current.fingerprints[offset + index]);
            }
            alternativeDistance = Math.min(alternativeDistance, total / previous.count);
        }
        return stationaryDistance - alternativeDistance >= 0.1 ? 0 : confirmedBirthCount(additions);
    }
    if (current.count !== previous.count) return 0;

    const replacementEvidence =
        distance(current.fingerprint, previous.fingerprint) >= 0.1 ||
        stackShifted(previous.fingerprints, current.fingerprints, distance) ||
        strengthChange >= rowThreshold * 2;
    return replacementEvidence && averageStrength >= rowThreshold * 2 && strengthChange >= -rowThreshold / 2
        ? confirmedBirthCount(1)
        : 0;
}

/**
 * `retainHistory: false` is for bounded incremental consumers. Such consumers must drain both lifecycle queues after
 * every push and release each settled or ended track; otherwise those queues deliberately retain undelivered events.
 */
export type LootRowTrackerOptions = {
    retainHistory?: boolean;
    maxObservationsPerTrack?: number;
};

export class LootRowTracker<TFingerprint> {
    readonly tracks: LootTrack<TFingerprint>[] = [];
    private stack: LootTrack<TFingerprint>[] = [];
    private readonly newTracks: LootTrack<TFingerprint>[] = [];
    private readonly endedTracks: LootTrack<TFingerprint>[] = [];
    private readonly releasedTracks = new Set<LootTrack<TFingerprint>>();
    private readonly retainHistory: boolean;
    private readonly maxObservationsPerTrack: number;
    private nextId = 1;
    private emptyFrames = 0;
    private frameCount = 0;
    private previous: LootDetectedRows<TFingerprint> | undefined;
    private pending: { frame: number; rows: LootDetectedRows<TFingerprint> } | undefined;
    private finished = false;

    constructor(
        private readonly rowThreshold: number,
        private readonly distance: FingerprintDistance<TFingerprint>,
        options: LootRowTrackerOptions = {},
    ) {
        this.retainHistory = options.retainHistory ?? true;
        this.maxObservationsPerTrack = options.maxObservationsPerTrack ?? Number.POSITIVE_INFINITY;
        if (
            this.maxObservationsPerTrack !== Number.POSITIVE_INFINITY &&
            (this.maxObservationsPerTrack < 1 || !Number.isInteger(this.maxObservationsPerTrack))
        ) {
            throw new Error("Maximum loot observations per track must be a positive integer.");
        }
    }

    private createTrack(firstFrame: number, baseline: boolean) {
        const track: LootTrack<TFingerprint> = {
            id: `detected-${String(this.nextId).padStart(4, "0")}`,
            firstFrame,
            baseline,
            observations: [],
        };
        this.nextId += 1;
        this.tracks.push(track);
        this.newTracks.push(track);
        return track;
    }

    private endTrack(track: LootTrack<TFingerprint>) {
        this.endedTracks.push(track);
        if (this.releasedTracks.delete(track)) track.observations.length = 0;
        if (!this.retainHistory) {
            const index = this.tracks.indexOf(track);
            if (index >= 0) this.tracks.splice(index, 1);
        }
    }

    private replaceStack(stack: LootTrack<TFingerprint>[]) {
        const retained = new Set(stack);
        for (const track of this.stack) {
            if (!retained.has(track)) this.endTrack(track);
        }
        this.stack = stack;
    }

    private observe(track: LootTrack<TFingerprint>, observation: LootRowObservation<TFingerprint> & { frame: number }) {
        track.observations.push(observation);
        const limit = this.releasedTracks.has(track) ? 1 : this.maxObservationsPerTrack;
        if (track.observations.length > limit) {
            track.observations.splice(0, track.observations.length - limit);
        }
    }

    private bestTrackAlignment(current: LootDetectedRows<TFingerprint>) {
        const retained = Math.min(this.stack.length, current.count);
        if (retained === 0) {
            return { sourceOffset: 0, targetOffset: 0, retained, distance: Number.POSITIVE_INFINITY };
        }
        let best:
            | { sourceOffset: number; targetOffset: number; retained: number; distance: number; nonBaseline: number }
            | undefined;
        for (let sourceOffset = this.stack.length - retained; sourceOffset >= 0; sourceOffset -= 1) {
            const nonBaseline = this.stack
                .slice(sourceOffset, sourceOffset + retained)
                .filter((track) => !track.baseline).length;
            for (let targetOffset = 0; targetOffset <= current.count - retained; targetOffset += 1) {
                let total = 0;
                for (let index = 0; index < retained; index += 1) {
                    total += this.distance(
                        this.stack[sourceOffset + index].observations[
                            this.stack[sourceOffset + index].observations.length - 1
                        ]?.fingerprint,
                        current.observations[targetOffset + index].fingerprint,
                    );
                }
                const candidate = { sourceOffset, targetOffset, retained, distance: total / retained, nonBaseline };
                if (
                    !best ||
                    candidate.distance < best.distance ||
                    (candidate.distance === best.distance && candidate.nonBaseline > best.nonBaseline)
                ) {
                    best = candidate;
                }
            }
        }
        if (!best) throw new Error("Loot row alignment failed.");
        return best;
    }

    private align(frame: number, current: LootDetectedRows<TFingerprint>, birthCount: number, baseline = false) {
        if (birthCount === 0) {
            if (current.count === 0) return;
            const { sourceOffset, targetOffset, retained } = this.bestTrackAlignment(current);
            const aligned: LootTrack<TFingerprint>[] = [];
            for (let index = 0; index < current.count; index += 1) {
                aligned.push(
                    index >= targetOffset && index < targetOffset + retained
                        ? this.stack[sourceOffset + index - targetOffset]
                        : this.createTrack(frame, true),
                );
            }
            this.replaceStack(aligned);
            for (let index = 0; index < this.stack.length; index += 1) {
                this.observe(this.stack[index], { frame, ...current.observations[index] });
            }
            return;
        }

        const retainedCount = Math.max(0, current.count - birthCount);
        const stack = this.stack.slice(Math.max(0, this.stack.length - retainedCount));
        while (stack.length < retainedCount) stack.unshift(this.createTrack(frame, true));
        for (let index = 0; index < birthCount; index += 1) stack.push(this.createTrack(frame, baseline));
        while (stack.length < current.count) stack.push(this.createTrack(frame, true));
        this.replaceStack(stack.length > current.count ? stack.slice(stack.length - current.count) : stack);
        for (let index = 0; index < this.stack.length; index += 1) {
            this.observe(this.stack[index], { frame, ...current.observations[index] });
        }
    }

    private processPending(next: LootDetectedRows<TFingerprint> | undefined) {
        if (!this.previous || !this.pending) return;
        const { frame, rows: current } = this.pending;
        let births = rowBirthCount(this.previous, current, next, this.rowThreshold, this.distance);
        if (this.emptyFrames === 1 && this.stack.length > 0) {
            const recovery = this.bestTrackAlignment(current);
            if (recovery.distance <= 0.1) {
                const unmatchedBottom = current.count - recovery.targetOffset - recovery.retained;
                births = Math.min(births, unmatchedBottom);
            }
        }
        this.align(frame, current, births);
        if (current.count === 0) {
            this.emptyFrames += 1;
            if (this.emptyFrames > 1) this.replaceStack([]);
        } else {
            this.emptyFrames = 0;
        }
        this.previous = current;
        this.pending = undefined;
    }

    push(rows: LootDetectedRows<TFingerprint>): void {
        if (this.finished) throw new Error("Cannot push loot rows after the tracker is finished.");
        const frame = this.frameCount;
        this.frameCount += 1;
        if (frame === 0) {
            this.align(frame, rows, rows.count, true);
            this.emptyFrames = rows.count === 0 ? 1 : 0;
            this.previous = rows;
            return;
        }
        this.processPending(rows);
        this.pending = { frame, rows };
    }

    finish(): LootTrack<TFingerprint>[] {
        if (!this.finished) {
            this.processPending(undefined);
            this.finished = true;
        }
        return this.tracks;
    }

    /** Drains tracks created since the previous call. Required after every push in non-history mode. */
    takeNewTracks() {
        return this.newTracks.splice(0);
    }

    /** Drains tracks that left the active stack since the previous call. Required in non-history mode. */
    takeEndedTracks() {
        return this.endedTracks.splice(0);
    }

    /** Compacts an active track to its alignment observation, or clears an ended track. */
    releaseTrack(track: LootTrack<TFingerprint>) {
        if (this.stack.includes(track)) {
            this.releasedTracks.add(track);
            if (track.observations.length > 1) track.observations.splice(0, track.observations.length - 1);
            return;
        }
        track.observations.length = 0;
    }

    clear() {
        const retained = new Set([...this.tracks, ...this.stack, ...this.newTracks, ...this.endedTracks]);
        for (const track of retained) track.observations.length = 0;
        this.tracks.length = 0;
        this.stack.length = 0;
        this.newTracks.length = 0;
        this.endedTracks.length = 0;
        this.releasedTracks.clear();
        this.previous = undefined;
        this.pending = undefined;
        this.finished = true;
    }
}

export function trackLootRows<TFingerprint>(
    rows: LootDetectedRows<TFingerprint>[],
    rowThreshold: number,
    distance: FingerprintDistance<TFingerprint>,
): LootTrack<TFingerprint>[] {
    const tracker = new LootRowTracker(rowThreshold, distance);
    for (const current of rows) tracker.push(current);
    return tracker.finish();
}

export function selectLootOcrObservations<TFingerprint>(
    track: LootTrack<TFingerprint>,
    rowThreshold: number,
    { frameCount = 3, delayFrames = 1, minimumScoreMultiplier = 1 } = {},
) {
    let run: Array<LootRowObservation<TFingerprint> & { frame: number }> = [];
    for (const observation of track.observations) {
        const previous = run[run.length - 1];
        const eligible =
            observation.frame >= track.firstFrame + delayFrames &&
            observation.score >= rowThreshold * minimumScoreMultiplier;
        if (!eligible || (previous && observation.frame !== previous.frame + 1)) run = [];
        if (!eligible) continue;
        run.push(observation);
        if (run.length === frameCount) return run;
    }
    return [];
}

function normalizeItem(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseLootQuantity(text: string) {
    const suffix = text.match(/x\s*(\d+|[|Il])\s*$/i)?.[1];
    if (!suffix) return null;
    if (/^[|Il]$/i.test(suffix)) return 1;
    const quantity = Number(suffix);
    return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function editDistance(left: string, right: string) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            current[rightIndex] = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
            );
        }
        previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
}

export function parseLootItem(text: string, dictionary: readonly string[]) {
    const reading = text.match(/^(.*?)\s+x\s*(?:\d+|[|Il])\s*$/i)?.[1];
    if (!reading) return null;
    const normalized = normalizeItem(reading);
    const candidates = dictionary
        .map((item) => {
            const candidate = normalizeItem(item);
            return {
                item,
                distance: editDistance(normalized, candidate) / Math.max(normalized.length, candidate.length),
            };
        })
        .sort((left, right) => left.distance - right.distance);
    if (candidates[0]?.distance > 0.35 || candidates[0]?.distance === candidates[1]?.distance) return null;
    return candidates[0]?.item ?? null;
}

function chooseTemporalPairConsensus(readingsByFrame: Array<Array<{ item: string | null; quantity: number | null }>>) {
    const counts = new Map<string, { count: number; item: string; quantity: number }>();
    for (const readings of readingsByFrame) {
        const unique = new Map<string, { item: string; quantity: number }>();
        for (const reading of readings) {
            if (reading.item === null || reading.quantity === null) continue;
            unique.set(`${reading.item}\0${reading.quantity}`, { item: reading.item, quantity: reading.quantity });
        }
        for (const [key, reading] of unique) {
            const current = counts.get(key);
            counts.set(key, { ...reading, count: (current?.count ?? 0) + 1 });
        }
    }
    const ranked = [...counts.values()].sort((left, right) => right.count - left.count);
    return ranked[0]?.count >= 2 && ranked[0].count > (ranked[1]?.count ?? 0) ? ranked[0] : null;
}

function parseLootReadings(rawReadings: readonly (readonly string[])[], dictionary: readonly string[]) {
    return chooseTemporalPairConsensus(
        rawReadings.map((frameReadings) =>
            frameReadings.map((text) => ({
                item: parseLootItem(text, dictionary),
                quantity: parseLootQuantity(text),
            })),
        ),
    );
}

const defaultRetainedFrameCount = 4;
const defaultMaxPendingResults = 16;

type LootResultMetadata = {
    eventId: string;
    firstFrame: number;
    selectedFrames: number[];
};

type LootOcrDelivery = LootResultMetadata & {
    kind: "ocr";
    frames: LiveLootOcrFrame[];
    generation: number;
};

type LootResultDelivery = {
    kind: "result";
    result: LiveLootEventResult;
    generation: number;
};

type LootSummaryDelivery = {
    kind: "summary";
    result: LiveLootOverflowSummary;
    generation: number;
};

type LootDelivery = LootOcrDelivery | LootResultDelivery | LootSummaryDelivery;

export class LiveLootCoordinator {
    private readonly tracker: LootRowTracker<LootFingerprint>;
    private readonly frames = new Map<number, LootRoiFrame>();
    private readonly candidates = new Set<LootTrack<LootFingerprint>>();
    private readonly deliveries: LootDelivery[] = [];
    private readonly abortController = new AbortController();
    private pendingSummary: LootSummaryDelivery | undefined;
    private activeOcrDelivery: LootOcrDelivery | undefined;
    private state: "active" | "finishing" | "finished" | "stopped" = "active";
    private nextFrame = 0;
    private pendingOcrJobs = 0;
    private pendingResultEntries = 0;
    private draining = false;
    private deliveringCallback = false;
    private generation = 0;
    private finishPromise: Promise<void> | undefined;
    private finishResolve: (() => void) | undefined;
    private finishReject: ((reason?: unknown) => void) | undefined;
    private finishSettled = false;
    private callbackFailed = false;
    private callbackError: unknown;
    private finishFailed = false;
    private finishError: unknown;

    constructor(private readonly options: LiveLootCoordinatorOptions) {
        validateProfile(options.profile);
        const maxPendingOcrJobs = options.maxPendingOcrJobs ?? 2;
        const maxPendingResults = options.maxPendingResults ?? defaultMaxPendingResults;
        const retainedFrameCount = options.retainedFrameCount ?? defaultRetainedFrameCount;
        if (!Number.isInteger(maxPendingOcrJobs) || maxPendingOcrJobs < 1) {
            throw new Error("Maximum pending loot OCR jobs must be a positive integer.");
        }
        if (!Number.isInteger(retainedFrameCount) || retainedFrameCount < defaultRetainedFrameCount) {
            throw new Error(`Retained loot frame count must be at least ${defaultRetainedFrameCount}.`);
        }
        if (!Number.isInteger(maxPendingResults) || maxPendingResults < 1) {
            throw new Error("Maximum pending loot results must be a positive integer.");
        }
        this.maxPendingOcrJobs = maxPendingOcrJobs;
        this.maxPendingResults = maxPendingResults;
        this.maximumRetainedFrames = retainedFrameCount;
        this.tracker = new LootRowTracker(options.profile.rowThreshold, lootFingerprintDistance, {
            retainHistory: false,
            maxObservationsPerTrack: 3,
        });
    }

    private readonly maxPendingOcrJobs: number;
    private readonly maxPendingResults: number;
    private readonly maximumRetainedFrames: number;

    get retainedFrameCount() {
        return this.frames.size;
    }

    get retainedTrackCount() {
        return this.tracker.tracks.length;
    }

    get retainedObservationCount() {
        return this.tracker.tracks.reduce((count, track) => count + track.observations.length, 0);
    }

    get pendingCandidateCount() {
        return this.candidates.size;
    }

    get queuedDeliveryCount() {
        return this.deliveries.length;
    }

    get queuedSummaryCount() {
        return this.pendingSummary ? 1 : 0;
    }

    private resultMetadata(track: LootTrack<LootFingerprint>, selectedFrames: number[]): LootResultMetadata {
        return {
            eventId: track.id,
            firstFrame: track.firstFrame,
            selectedFrames,
        };
    }

    private emptyResult(metadata: LootResultMetadata) {
        return {
            eventId: metadata.eventId,
            firstFrame: metadata.firstFrame,
            selectedFrames: metadata.selectedFrames,
            itemName: null as null,
            quantity: null as null,
        };
    }

    private updateSummaryReason(summary: LiveLootOverflowSummary) {
        summary.reason =
            summary.backpressureCount > 0 && summary.resultOverflowCount > 0
                ? "mixed-overflow-summary"
                : summary.backpressureCount > 0
                  ? "backpressure-summary"
                  : "result-overflow-summary";
    }

    private summarize(metadata: LootResultMetadata, overflow: "backpressure" | "result") {
        if (this.pendingSummary) {
            const summary = this.pendingSummary.result;
            summary.count += 1;
            summary.lastEventId = metadata.eventId;
            summary.lastFrame = metadata.firstFrame;
            if (overflow === "backpressure") summary.backpressureCount += 1;
            else summary.resultOverflowCount += 1;
            this.updateSummaryReason(summary);
            return;
        }

        const result: LiveLootOverflowSummary = {
            eventId: null,
            firstFrame: metadata.firstFrame,
            selectedFrames: [],
            itemName: null,
            quantity: null,
            status: "dropped",
            reason: overflow === "backpressure" ? "backpressure-summary" : "result-overflow-summary",
            count: 1,
            backpressureCount: overflow === "backpressure" ? 1 : 0,
            resultOverflowCount: overflow === "result" ? 1 : 0,
            firstEventId: metadata.eventId,
            lastEventId: metadata.eventId,
            lastFrame: metadata.firstFrame,
        };
        const delivery: LootSummaryDelivery = { kind: "summary", result, generation: this.generation };
        this.pendingSummary = delivery;
        this.deliveries.push(delivery);
    }

    private queueResult(result: LiveLootEventResult) {
        const metadata = {
            eventId: result.eventId,
            firstFrame: result.firstFrame,
            selectedFrames: result.selectedFrames,
        };
        if (
            this.pendingSummary ||
            this.pendingResultEntries + (this.deliveringCallback ? 1 : 0) >= this.maxPendingResults
        ) {
            this.summarize(metadata, "result");
            return;
        }
        this.pendingResultEntries += 1;
        this.deliveries.push({ kind: "result", result, generation: this.generation });
    }

    private settleCandidate(track: LootTrack<LootFingerprint>) {
        const selected = selectLootOcrObservations(track, this.options.profile.rowThreshold);
        if (selected.length !== 3) return false;

        const metadata = this.resultMetadata(
            track,
            selected.map(({ frame }) => frame),
        );
        if (this.pendingSummary) {
            this.summarize(metadata, this.pendingOcrJobs >= this.maxPendingOcrJobs ? "backpressure" : "result");
        } else if (this.pendingOcrJobs >= this.maxPendingOcrJobs) {
            this.summarize(metadata, "backpressure");
        } else {
            const frames = selected.map((observation) => {
                const roi = this.frames.get(observation.frame);
                if (!roi) throw new Error(`Selected loot frame ${observation.frame} is no longer retained.`);
                return { frame: observation.frame, roi, observation };
            });
            this.pendingOcrJobs += 1;
            this.deliveries.push({ kind: "ocr", ...metadata, frames, generation: this.generation });
        }
        this.candidates.delete(track);
        this.tracker.releaseTrack(track);
        return true;
    }

    private processTrackerChanges() {
        for (const track of this.tracker.takeEndedTracks()) {
            if (this.candidates.delete(track)) {
                const metadata = this.resultMetadata(track, []);
                this.queueResult({
                    ...this.emptyResult(metadata),
                    status: "withheld",
                    reason: "insufficient-observations",
                });
            }
            this.tracker.releaseTrack(track);
        }
        for (const track of this.tracker.takeNewTracks()) {
            if (track.baseline) this.tracker.releaseTrack(track);
            else this.candidates.add(track);
        }
        for (const track of this.candidates) {
            this.settleCandidate(track);
        }
    }

    private recordCallbackError(error: unknown) {
        if (!this.callbackFailed) {
            this.callbackFailed = true;
            this.callbackError = error;
        }
    }

    private deliver(result: LiveLootRecognitionResult, generation: number) {
        if (this.state === "stopped" || generation !== this.generation) return;
        this.deliveringCallback = true;
        try {
            const returned = this.options.onResult(result) as unknown;
            if (
                returned !== null &&
                (typeof returned === "object" || typeof returned === "function") &&
                typeof (returned as { then?: unknown }).then === "function"
            ) {
                this.recordCallbackError(new Error("Live loot result callbacks must be synchronous."));
                void Promise.resolve(returned).catch(() => undefined);
            }
        } catch (error) {
            this.recordCallbackError(error);
        } finally {
            this.deliveringCallback = false;
            this.maybeSettleFinish();
        }
    }

    private async drainDeliveries() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.deliveries.length > 0 && this.state !== "stopped") {
                const delivery = this.deliveries.shift();
                if (!delivery) break;
                if (delivery.kind !== "ocr") {
                    if (delivery.kind === "summary" && this.pendingSummary === delivery) {
                        this.pendingSummary = undefined;
                    } else if (delivery.kind === "result") {
                        this.pendingResultEntries -= 1;
                    }
                    this.deliver(delivery.result, delivery.generation);
                    continue;
                }

                let result: LiveLootRecognitionResult | undefined;
                this.activeOcrDelivery = delivery;
                try {
                    const rawReadings = await this.options.readText(delivery.frames, this.abortController.signal);
                    if (rawReadings.length !== delivery.frames.length) {
                        throw new Error("Loot OCR readings must match the selected frame count.");
                    }
                    if (delivery.generation === this.generation) {
                        const metadata = this.emptyResult(delivery);
                        const consensus = parseLootReadings(rawReadings, this.options.dictionary);
                        result = consensus
                            ? {
                                  ...metadata,
                                  status: "recognized",
                                  reason: null,
                                  itemName: consensus.item,
                                  quantity: consensus.quantity,
                              }
                            : {
                                  ...metadata,
                                  status: "withheld",
                                  reason: "consensus-withheld",
                              };
                    }
                } catch {
                    result = {
                        ...this.emptyResult(delivery),
                        status: "failed",
                        reason: "ocr-failure",
                    };
                } finally {
                    delivery.frames.length = 0;
                    if (this.activeOcrDelivery === delivery) this.activeOcrDelivery = undefined;
                    this.pendingOcrJobs -= 1;
                }
                if (result) this.deliver(result, delivery.generation);
            }
        } finally {
            this.draining = false;
            this.maybeSettleFinish();
        }
    }

    private startDraining() {
        void this.drainDeliveries();
    }

    private createFinishPromise() {
        this.finishPromise = new Promise<void>((resolve, reject) => {
            this.finishResolve = resolve;
            this.finishReject = reject;
        });
        return this.finishPromise;
    }

    private maybeSettleFinish() {
        if (!this.finishPromise || this.finishSettled) return;
        if (this.deliveringCallback) return;
        if (this.state !== "stopped" && (this.state !== "finishing" || this.draining || this.deliveries.length > 0)) {
            return;
        }
        if (this.state === "finishing") this.state = "finished";
        this.finishSettled = true;
        if (this.finishFailed) this.finishReject?.(this.finishError);
        else if (this.callbackFailed) this.finishReject?.(this.callbackError);
        else this.finishResolve?.();
    }

    private finishCandidates() {
        for (const track of this.candidates) {
            const selected = selectLootOcrObservations(track, this.options.profile.rowThreshold);
            if (selected.length === 3) {
                this.settleCandidate(track);
            } else {
                const metadata = this.resultMetadata(track, []);
                this.queueResult({
                    ...this.emptyResult(metadata),
                    status: "withheld",
                    reason: "insufficient-observations",
                });
                this.candidates.delete(track);
                this.tracker.releaseTrack(track);
            }
        }
    }

    /**
     * Takes ownership of `frame` and its pixel buffer without copying. The caller must not mutate or reuse either
     * after this call. Ownership is released after the frame leaves the rolling store and any selected OCR job settles.
     */
    pushFrame(frame: LootRoiFrame) {
        if (this.state !== "active")
            throw new Error("Cannot push loot frames after the coordinator is stopped or finished.");
        const rows = analyzeLootRoiFrame(frame, this.options.profile);
        const frameNumber = this.nextFrame;
        this.nextFrame += 1;
        this.frames.set(frameNumber, frame);
        while (this.frames.size > this.maximumRetainedFrames) {
            const oldest = this.frames.keys().next().value;
            if (oldest === undefined) break;
            this.frames.delete(oldest);
        }
        this.tracker.push(rows);
        this.processTrackerChanges();
        this.startDraining();
    }

    finish(): Promise<void> {
        if (this.finishPromise) return this.finishPromise;
        const finishPromise = this.createFinishPromise();
        if (this.state === "stopped") {
            this.maybeSettleFinish();
            return finishPromise;
        }
        this.state = "finishing";
        try {
            this.tracker.finish();
            this.processTrackerChanges();
            this.finishCandidates();
        } catch (error) {
            this.finishFailed = true;
            this.finishError = error;
        }
        this.candidates.clear();
        this.tracker.clear();
        this.frames.clear();
        this.startDraining();
        this.maybeSettleFinish();
        return finishPromise;
    }

    stop() {
        if (this.state === "stopped" || this.state === "finished") return;
        this.state = "stopped";
        this.generation += 1;
        this.abortController.abort();
        if (this.activeOcrDelivery) this.activeOcrDelivery.frames.length = 0;
        for (const delivery of this.deliveries) {
            if (delivery.kind === "ocr") {
                delivery.frames.length = 0;
                this.pendingOcrJobs -= 1;
            } else if (delivery.kind === "result") {
                this.pendingResultEntries -= 1;
            }
        }
        this.deliveries.length = 0;
        this.pendingSummary = undefined;
        this.frames.clear();
        this.candidates.clear();
        this.tracker.clear();
        this.maybeSettleFinish();
    }
}

export async function recognizeLootReplay<TFingerprint>(options: {
    rows: LootDetectedRows<TFingerprint>[];
    rowThreshold: number;
    distance: FingerprintDistance<TFingerprint>;
    dictionary: readonly string[];
    readText: (
        track: LootTrack<TFingerprint>,
        observations: Array<LootRowObservation<TFingerprint> & { frame: number }>,
    ) => Promise<readonly (readonly string[])[]>;
}): Promise<LootRecognitionResult[]> {
    const tracks = trackLootRows(options.rows, options.rowThreshold, options.distance).filter(
        (track) => !track.baseline,
    );
    const results: LootRecognitionResult[] = [];
    for (const track of tracks) {
        const selected = selectLootOcrObservations(track, options.rowThreshold);
        const rawReadings = selected.length > 0 ? await options.readText(track, selected) : [];
        if (rawReadings.length !== selected.length) {
            throw new Error("Loot OCR readings must match the selected frame count.");
        }
        const consensus = parseLootReadings(rawReadings, options.dictionary);
        results.push({
            eventId: track.id,
            firstFrame: track.firstFrame,
            selectedFrames: selected.map(({ frame }) => frame),
            itemName: consensus?.item ?? null,
            quantity: consensus?.quantity ?? null,
        });
    }
    return results;
}
