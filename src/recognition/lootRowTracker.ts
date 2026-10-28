import type {
    FingerprintDistance,
    LootDetectedRows,
    LootFingerprint,
    LootOcrSelectionOptions,
    LootRowObservation,
    LootTrack,
} from "./liveLoot";
import { fadeWithoutArrival, fadingLootArrivals, lootRowRefreshed, lootRowsFaded } from "./lootArrival";

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
    const births = Math.max(
        projectionBirthCount(previous, current, next, rowThreshold, distance),
        fadingLootArrivals(previous, current, next),
    );
    return births > 0 && fadeWithoutArrival(previous, current, next, births) ? 0 : births;
}

function projectionBirthCount<TFingerprint>(
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
    if (alignedBirths > additions && stationaryDistance - bestDistance >= 0.1 && averageStrength >= rowThreshold) {
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

    const shifted = stackShifted(previous.fingerprints, current.fingerprints, distance);
    if (
        next?.count === current.count &&
        distance(next.fingerprint, previous.fingerprint) < maximumContinuityDistance &&
        !shifted &&
        !stackShifted(current.fingerprints, next.fingerprints, distance) &&
        strengthChange < rowThreshold * 2
    )
        return 0;
    const replacementEvidence =
        distance(current.fingerprint, previous.fingerprint) >= 0.1 || shifted || strengthChange >= rowThreshold * 2;
    // A different, shorter item can lower total brightness while older rows fade. A large identity change still
    // needs the normal lookahead confirmation; brightness loss alone must not veto that new drop.
    const strongIdentityChange = distance(current.fingerprint, previous.fingerprint) >= 0.3;
    return replacementEvidence &&
        averageStrength >= rowThreshold * (strongIdentityChange ? 1 : 2) &&
        (strengthChange >= -rowThreshold / 2 || strongIdentityChange)
        ? confirmedBirthCount(1)
        : 0;
}

/**
 * `retainHistory: false` is for bounded incremental consumers. Such consumers must drain both lifecycle queues after
 * every push and release each settled or ended track; otherwise those queues deliberately retain undelivered events.
 */
export type LootRowTrackerOptions<TFingerprint = LootFingerprint> = {
    identityDistance?: FingerprintDistance<TFingerprint>;
    retainHistory?: boolean;
    maxObservationsPerTrack?: number;
    emptyFrameLimit?: 2 | 4;
    eventIdPrefix?: string;
};

export class LootRowTracker<TFingerprint> {
    readonly tracks: LootTrack<TFingerprint>[] = [];
    private stack: LootTrack<TFingerprint>[] = [];
    private readonly newTracks: LootTrack<TFingerprint>[] = [];
    private readonly endedTracks: LootTrack<TFingerprint>[] = [];
    private readonly releasedTracks = new Set<LootTrack<TFingerprint>>();
    private readonly retainHistory: boolean;
    private readonly maxObservationsPerTrack: number;
    private readonly eventIdPrefix: string;
    private readonly emptyFrameLimit: number;
    private readonly identityDistance: FingerprintDistance<TFingerprint>;
    private nextId = 1;
    private emptyFrames = 0;
    private frameCount = 0;
    private previous: LootDetectedRows<TFingerprint> | undefined;
    private lastVisible: LootDetectedRows<TFingerprint> | undefined;
    private pending: { frame: number; rows: LootDetectedRows<TFingerprint> } | undefined;
    private finished = false;

    constructor(
        private readonly rowThreshold: number,
        private readonly distance: FingerprintDistance<TFingerprint>,
        options: LootRowTrackerOptions<TFingerprint> = {},
    ) {
        this.emptyFrameLimit = options.emptyFrameLimit ?? 2;
        this.identityDistance = options.identityDistance ?? distance;
        this.retainHistory = options.retainHistory ?? true;
        this.maxObservationsPerTrack = options.maxObservationsPerTrack ?? Number.POSITIVE_INFINITY;
        this.eventIdPrefix = options.eventIdPrefix ?? "detected";
        if (
            this.maxObservationsPerTrack !== Number.POSITIVE_INFINITY &&
            (this.maxObservationsPerTrack < 1 || !Number.isInteger(this.maxObservationsPerTrack))
        ) {
            throw new Error("Maximum loot observations per track must be a positive integer.");
        }
        if (!/^[a-z][a-z0-9-]*$/.test(this.eventIdPrefix)) {
            throw new Error("Loot event ID prefixes must use lowercase letters, numbers, and hyphens.");
        }
    }

    private createTrack(firstFrame: number, baseline: boolean) {
        const track: LootTrack<TFingerprint> = {
            id: `${this.eventIdPrefix}-${String(this.nextId).padStart(4, "0")}`,
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
        if (this.previous?.count === this.stack.length && lootRowsFaded(this.previous, current)) {
            return { sourceOffset: this.stack.length - retained, targetOffset: 0, retained, distance: 0 };
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
                    total += this.identityDistance(
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

    /** The most stack rows that reappear, in order, at the top of `current`; 0 when no scroll explains the frame. */
    private scrolledRowsAfterGap(current: LootDetectedRows<TFingerprint>) {
        for (let retained = Math.min(this.stack.length, current.count) - 1; retained >= 1; retained -= 1) {
            const sourceOffset = this.stack.length - retained;
            let total = 0;
            for (let index = 0; index < retained; index += 1) {
                const track = this.stack[sourceOffset + index];
                total += this.identityDistance(
                    track.observations[track.observations.length - 1]?.fingerprint,
                    current.observations[index].fingerprint,
                );
            }
            if (total / retained <= 0.1) return retained;
        }
        return 0;
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
        if (
            births === 1 &&
            fadingLootArrivals(this.previous, current, next) === 0 &&
            this.stack[this.stack.length - 1]?.firstFrame === frame - 1 &&
            current.count === this.previous.count &&
            this.previous.fingerprints.every(
                (fingerprint, index) => this.distance(fingerprint, current.fingerprints[index]) < 0.1,
            )
        ) {
            births = 0;
        }
        if (
            this.emptyFrames > 0 &&
            this.emptyFrames < this.emptyFrameLimit &&
            this.stack.length > 0 &&
            !(this.lastVisible && lootRowRefreshed(this.lastVisible, current))
        ) {
            const recovery = this.bestTrackAlignment(current);
            if (recovery.distance <= 0.1) {
                const unmatchedBottom = current.count - recovery.targetOffset - recovery.retained;
                births = Math.min(births, unmatchedBottom);
            } else {
                // The feed may have scrolled during the gap: older rows left the top and new rows entered below.
                const retained = this.scrolledRowsAfterGap(current);
                if (retained > 0) births = Math.min(births, current.count - retained);
            }
        }
        this.align(frame, current, births);
        if (current.count === 0) {
            this.emptyFrames += 1;
            if (this.emptyFrames >= this.emptyFrameLimit) this.replaceStack([]);
        } else {
            this.emptyFrames = 0;
            this.lastVisible = current;
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
            if (rows.count > 0) this.lastVisible = rows;
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
        this.lastVisible = undefined;
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
    {
        frameCount = 3,
        frameStep = 1,
        delayFrames = 1,
        windowFrames = frameCount,
        maximumFrameCount = frameCount,
    }: LootOcrSelectionOptions = {},
    distance?: FingerprintDistance<TFingerprint>,
) {
    let run: Array<LootRowObservation<TFingerprint> & { frame: number }> = [];
    let best: typeof run = [];
    let bestQuality = -1;
    for (const observation of track.observations) {
        const previous = run[run.length - 1];
        const spacedPrevious = frameStep > 1 ? run[run.length - frameStep] : undefined;
        const eligible = observation.frame >= track.firstFrame + delayFrames && observation.score >= rowThreshold;
        if (
            !eligible ||
            (previous &&
                (observation.frame !== previous.frame + 1 ||
                    (distance?.(previous.fingerprint, observation.fingerprint) ?? 0) > 0.1)) ||
            (spacedPrevious && (distance?.(spacedPrevious.fingerprint, observation.fingerprint) ?? 0) > 0.1)
        ) {
            if (best.length >= frameCount) break;
            run = [];
        }
        if (!eligible) continue;
        run.push(observation);
        const spaced = run.filter((_, index) => index % frameStep === 0);
        if (spaced.length >= frameCount) {
            // Keep the original evidence: a later consistent row must not replace a conflicting earlier reading.
            const selected = [
                ...spaced.slice(0, frameCount),
                ...spaced
                    .slice(frameCount)
                    .sort(
                        (left, right) =>
                            (right.quality ?? right.score) - (left.quality ?? left.score) || left.frame - right.frame,
                    )
                    .slice(0, maximumFrameCount - frameCount),
            ];
            const quality = selected
                .slice(frameCount)
                .reduce((sum, observation) => sum + (observation.quality ?? observation.score), 0);
            if (selected.length > best.length || (selected.length === best.length && quality > bestQuality)) {
                best = selected.sort((left, right) => left.frame - right.frame);
                bestQuality = quality;
            }
        }
        if (run.length === (windowFrames - 1) * frameStep + 1) break;
    }
    return best;
}
