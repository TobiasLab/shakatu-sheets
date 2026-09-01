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

type FingerprintDistance<TFingerprint> = (left: TFingerprint | undefined, right: TFingerprint | undefined) => number;

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

export function trackLootRows<TFingerprint>(
    rows: LootDetectedRows<TFingerprint>[],
    rowThreshold: number,
    distance: FingerprintDistance<TFingerprint>,
): LootTrack<TFingerprint>[] {
    const tracks: LootTrack<TFingerprint>[] = [];
    let stack: LootTrack<TFingerprint>[] = [];
    let nextId = 1;
    let emptyFrames = rows[0]?.count === 0 ? 1 : 0;

    function createTrack(firstFrame: number, baseline: boolean) {
        const track: LootTrack<TFingerprint> = {
            id: `detected-${String(nextId).padStart(4, "0")}`,
            firstFrame,
            baseline,
            observations: [],
        };
        nextId += 1;
        tracks.push(track);
        return track;
    }

    function bestTrackAlignment(current: LootDetectedRows<TFingerprint>) {
        const retained = Math.min(stack.length, current.count);
        if (retained === 0) {
            return { sourceOffset: 0, targetOffset: 0, retained, distance: Number.POSITIVE_INFINITY };
        }
        let best:
            | { sourceOffset: number; targetOffset: number; retained: number; distance: number; nonBaseline: number }
            | undefined;
        for (let sourceOffset = stack.length - retained; sourceOffset >= 0; sourceOffset -= 1) {
            const nonBaseline = stack
                .slice(sourceOffset, sourceOffset + retained)
                .filter((track) => !track.baseline).length;
            for (let targetOffset = 0; targetOffset <= current.count - retained; targetOffset += 1) {
                let total = 0;
                for (let index = 0; index < retained; index += 1) {
                    total += distance(
                        stack[sourceOffset + index].observations[stack[sourceOffset + index].observations.length - 1]
                            ?.fingerprint,
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

    function align(frame: number, current: LootDetectedRows<TFingerprint>, birthCount: number, baseline = false) {
        if (birthCount === 0) {
            if (current.count === 0) return;
            const { sourceOffset, targetOffset, retained } = bestTrackAlignment(current);
            const aligned: LootTrack<TFingerprint>[] = [];
            for (let index = 0; index < current.count; index += 1) {
                aligned.push(
                    index >= targetOffset && index < targetOffset + retained
                        ? stack[sourceOffset + index - targetOffset]
                        : createTrack(frame, true),
                );
            }
            stack = aligned;
            for (let index = 0; index < stack.length; index += 1) {
                stack[index].observations.push({ frame, ...current.observations[index] });
            }
            return;
        }

        const retainedCount = Math.max(0, current.count - birthCount);
        stack = stack.slice(Math.max(0, stack.length - retainedCount));
        while (stack.length < retainedCount) stack.unshift(createTrack(frame, true));
        for (let index = 0; index < birthCount; index += 1) stack.push(createTrack(frame, baseline));
        while (stack.length < current.count) stack.push(createTrack(frame, true));
        if (stack.length > current.count) stack = stack.slice(stack.length - current.count);
        for (let index = 0; index < stack.length; index += 1) {
            stack[index].observations.push({ frame, ...current.observations[index] });
        }
    }

    if (rows.length === 0) return tracks;
    align(0, rows[0], rows[0].count, true);
    for (let frame = 1; frame < rows.length; frame += 1) {
        const current = rows[frame];
        let births = rowBirthCount(rows[frame - 1], current, rows[frame + 1], rowThreshold, distance);
        if (emptyFrames === 1 && stack.length > 0) {
            const recovery = bestTrackAlignment(current);
            if (recovery.distance <= 0.1) {
                const unmatchedBottom = current.count - recovery.targetOffset - recovery.retained;
                births = Math.min(births, unmatchedBottom);
            }
        }
        align(frame, current, births);
        if (current.count === 0) {
            emptyFrames += 1;
            if (emptyFrames > 1) stack = [];
        } else {
            emptyFrames = 0;
        }
    }
    return tracks;
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
    return quantity > 0 ? quantity : null;
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
        const readings = rawReadings.map((frameReadings) =>
            frameReadings.map((text) => ({
                item: parseLootItem(text, options.dictionary),
                quantity: parseLootQuantity(text),
            })),
        );
        const consensus = chooseTemporalPairConsensus(readings);
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
