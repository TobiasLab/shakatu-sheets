const splits = new Set(["development", "validation", "test"]);

export function benchmarkEvents(segment) {
    return segment.events ?? [];
}

export function normalizeItem(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function validateGeneratedManifest(manifest, { requireItemDictionary = false } = {}) {
    const width = manifest.roi?.pixels?.width;
    const height = manifest.roi?.pixels?.height;
    if (![width, height, manifest.maxRows].every((value) => Number.isInteger(value) && value > 0)) {
        throw new Error("The generated manifest must contain positive integer ROI dimensions and maxRows.");
    }
    if (typeof manifest.sampleFps !== "number" || !Number.isFinite(manifest.sampleFps) || manifest.sampleFps <= 0) {
        throw new Error("The generated manifest must contain a positive sampleFps.");
    }
    if (!Array.isArray(manifest.segments) || manifest.segments.length === 0) {
        throw new Error("The generated manifest must contain at least one segment.");
    }

    const dictionary = manifest.itemDictionary;
    if (requireItemDictionary) {
        if (!Array.isArray(dictionary) || dictionary.length === 0) {
            throw new Error("The generated manifest must contain an itemDictionary.");
        }
        const normalized = dictionary.map((item) => (typeof item === "string" ? normalizeItem(item) : ""));
        if (normalized.some((item) => item.length === 0) || new Set(normalized).size !== normalized.length) {
            throw new Error("The generated manifest itemDictionary must contain unique item names.");
        }
    }

    let developmentEvents = 0;
    const segmentIds = new Set();
    for (const segment of manifest.segments) {
        if (typeof segment.id !== "string" || segment.id.length === 0 || segmentIds.has(segment.id)) {
            throw new Error("Generated segment IDs must be non-empty and unique.");
        }
        segmentIds.add(segment.id);
        if (!splits.has(segment.split)) throw new Error(`${segment.id}: invalid benchmark split.`);
        if (!Number.isInteger(segment.frameCount) || segment.frameCount <= 0) {
            throw new Error(`${segment.id}: frameCount must be a positive integer.`);
        }
        if (typeof segment.directory !== "string" || typeof segment.framePattern !== "string") {
            throw new Error(`${segment.id}: directory and framePattern are required.`);
        }
        if (segment.events !== undefined && !Array.isArray(segment.events)) {
            throw new Error(`${segment.id}: events must be an array when provided.`);
        }

        let previousFirstFrame = -1;
        const eventIds = new Set();
        const rowChanges = new Map();
        for (const event of benchmarkEvents(segment)) {
            if (typeof event.id !== "string" || event.id.length === 0 || eventIds.has(event.id)) {
                throw new Error(`${segment.id}: event IDs must be non-empty and unique.`);
            }
            eventIds.add(event.id);
            if (!Number.isInteger(event.quantity) || event.quantity <= 0) {
                throw new Error(`${segment.id}/${event.id}: quantity must be a positive integer.`);
            }
            if (typeof event.item !== "string" || event.item.length === 0) {
                throw new Error(`${segment.id}/${event.id}: item must be a non-empty string.`);
            }
            if (requireItemDictionary && !dictionary.includes(event.item)) {
                throw new Error(`${segment.id}/${event.id}: item must appear in itemDictionary.`);
            }
            if (
                ![event.firstFrame, event.stableFrame, event.lastFrame].every(Number.isInteger) ||
                event.firstFrame < 0 ||
                event.firstFrame > event.stableFrame ||
                event.stableFrame + 2 > event.lastFrame ||
                event.stableFrame > event.lastFrame ||
                event.lastFrame >= segment.frameCount
            ) {
                throw new Error(`${segment.id}/${event.id}: frame bounds are invalid.`);
            }
            if (event.firstFrame < previousFirstFrame) {
                throw new Error(`${segment.id}: events must be ordered by firstFrame.`);
            }
            previousFirstFrame = event.firstFrame;
            if ((event.firstFrame === 0) !== (event.baseline === true)) {
                throw new Error(`${segment.id}/${event.id}: frame-zero events must be marked baseline.`);
            }
            if (event.baseline !== undefined && typeof event.baseline !== "boolean") {
                throw new Error(`${segment.id}/${event.id}: baseline must be a boolean when provided.`);
            }
            if (event.truncated !== undefined && typeof event.truncated !== "boolean") {
                throw new Error(`${segment.id}/${event.id}: truncated must be a boolean when provided.`);
            }
            if (event.truncated === true && event.lastFrame !== segment.frameCount - 1) {
                throw new Error(`${segment.id}/${event.id}: truncated events must end on the final frame.`);
            }
            if (segment.split === "development") developmentEvents += 1;
            rowChanges.set(event.firstFrame, (rowChanges.get(event.firstFrame) ?? 0) + 1);
            rowChanges.set(event.lastFrame + 1, (rowChanges.get(event.lastFrame + 1) ?? 0) - 1);
        }
        let visibleRows = 0;
        for (const [, change] of [...rowChanges.entries()].sort((left, right) => left[0] - right[0])) {
            visibleRows += change;
            if (visibleRows > manifest.maxRows) throw new Error(`${segment.id}: annotations exceed maxRows.`);
        }
    }
    if (developmentEvents === 0) throw new Error("At least one annotated development event is required.");
}

export function calibrateThreshold(examples) {
    if (examples.length === 0) throw new Error("Threshold calibration requires labeled examples.");
    const scores = [...new Set(examples.map(({ score }) => score))].sort((left, right) => left - right);
    const candidates = [...scores, scores.at(-1) + 1];
    let best = { threshold: candidates[0], errors: Number.POSITIVE_INFINITY };
    for (const threshold of candidates) {
        const errors = examples.filter(({ score, occupied }) => score >= threshold !== occupied).length;
        if (errors < best.errors) best = { threshold, errors };
    }
    return best;
}

export function compareEvents(expectedFrames, actualFrames, tolerance = 1) {
    const expected = [...expectedFrames].sort((left, right) => left - right);
    const actual = [...actualFrames].sort((left, right) => left - right);
    const matches = [];
    const missed = [];
    const invented = [];
    let expectedIndex = 0;
    let actualIndex = 0;
    while (expectedIndex < expected.length && actualIndex < actual.length) {
        const expectedFrame = expected[expectedIndex];
        const actualFrame = actual[actualIndex];
        if (actualFrame < expectedFrame - tolerance) {
            invented.push(actualFrame);
            actualIndex += 1;
        } else if (actualFrame > expectedFrame + tolerance) {
            missed.push(expectedFrame);
            expectedIndex += 1;
        } else {
            matches.push({ expected: expectedFrame, actual: actualFrame });
            expectedIndex += 1;
            actualIndex += 1;
        }
    }
    missed.push(...expected.slice(expectedIndex));
    invented.push(...actual.slice(actualIndex));
    return { matches, missed, invented };
}

export function stackShifted(previous, current, distance, minimumImprovement = 0.1) {
    if (previous.length !== current.length || current.length < 2) return false;
    let stationaryDistance = 0;
    let shiftedDistance = 0;
    for (let index = 0; index < current.length - 1; index += 1) {
        stationaryDistance += distance(current[index], previous[index]);
        shiftedDistance += distance(current[index], previous[index + 1]);
    }
    return (stationaryDistance - shiftedDistance) / (current.length - 1) >= minimumImprovement;
}

export function rowBirthCount(previous, current, next, rowThreshold, distance) {
    const additions = Math.max(0, current.count - previous.count);
    if (current.count === 0) return 0;

    const maximumContinuityDistance = 0.1;
    function alignmentDistance(source, target, retained) {
        let total = 0;
        const sourceOffset = source.fingerprints.length - retained;
        for (let index = 0; index < retained; index += 1) {
            total += distance(source.fingerprints[sourceOffset + index], target.fingerprints[index]);
        }
        return total / retained;
    }

    function alignmentIsDiscriminative(source, target, retained, candidateDistance, minimumImprovement = 0.1) {
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

    function confirmedBirthCount(birthCount) {
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
    const birthCount =
        replacementEvidence && averageStrength >= rowThreshold * 2 && strengthChange >= -rowThreshold / 2 ? 1 : 0;
    return confirmedBirthCount(birthCount);
}

export function trackRowEvents(rows, rowThreshold, distance) {
    const tracks = [];
    let stack = [];
    let nextId = 1;
    let emptyFrames = rows[0]?.count === 0 ? 1 : 0;

    function createTrack(firstFrame, baseline) {
        const track = {
            id: `detected-${String(nextId).padStart(4, "0")}`,
            firstFrame,
            baseline,
            observations: [],
        };
        nextId += 1;
        tracks.push(track);
        return track;
    }

    function bestTrackAlignment(current) {
        const retained = Math.min(stack.length, current.count);
        if (retained === 0) return { sourceOffset: 0, targetOffset: 0, retained, distance: Number.POSITIVE_INFINITY };

        let best;
        for (let sourceOffset = stack.length - retained; sourceOffset >= 0; sourceOffset -= 1) {
            const nonBaseline = stack
                .slice(sourceOffset, sourceOffset + retained)
                .filter((track) => !track.baseline).length;
            for (let targetOffset = 0; targetOffset <= current.count - retained; targetOffset += 1) {
                let total = 0;
                for (let index = 0; index < retained; index += 1) {
                    total += distance(
                        stack[sourceOffset + index].observations.at(-1)?.fingerprint,
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
        return best;
    }

    function align(frame, current, birthCount, baseline = false) {
        if (birthCount === 0) {
            if (current.count === 0) return;
            const { sourceOffset, targetOffset, retained } = bestTrackAlignment(current);
            const aligned = [];
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
        align(frame, rows[frame], births);
        if (current.count === 0) {
            emptyFrames += 1;
            if (emptyFrames > 1) stack = [];
        } else {
            emptyFrames = 0;
        }
    }
    return tracks;
}

export function selectOcrObservations(
    track,
    rowThreshold,
    { frameCount = 3, delayFrames = 1, minimumScoreMultiplier = 1 } = {},
) {
    let run = [];
    for (const observation of track.observations) {
        const previous = run.at(-1);
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

export function compareDetectedEvents(expectedEvents, actualEvents, tolerance = 1) {
    const expected = expectedEvents
        .map((event, index) => ({ event, index }))
        .sort((left, right) => left.event.firstFrame - right.event.firstFrame || left.index - right.index);
    const actual = actualEvents
        .map((event, index) => ({ event, index }))
        .sort((left, right) => left.event.firstFrame - right.event.firstFrame || left.index - right.index);
    const matches = [];
    const missed = [];
    const invented = [];
    let expectedIndex = 0;
    let actualIndex = 0;
    while (expectedIndex < expected.length && actualIndex < actual.length) {
        const expectedEvent = expected[expectedIndex].event;
        const actualEvent = actual[actualIndex].event;
        if (actualEvent.firstFrame < expectedEvent.firstFrame - tolerance) {
            invented.push(actualEvent);
            actualIndex += 1;
        } else if (actualEvent.firstFrame > expectedEvent.firstFrame + tolerance) {
            missed.push(expectedEvent);
            expectedIndex += 1;
        } else {
            matches.push({ expected: expectedEvent, actual: actualEvent });
            expectedIndex += 1;
            actualIndex += 1;
        }
    }
    missed.push(...expected.slice(expectedIndex).map(({ event }) => event));
    invented.push(...actual.slice(actualIndex).map(({ event }) => event));
    return { matches, missed, invented };
}

export function parseQuantity(text) {
    const suffix = text.match(/x\s*(\d+|[|Il])\s*$/i)?.[1];
    if (!suffix) return "";
    if (/^[|Il]$/i.test(suffix)) return "1";
    return Number(suffix) > 0 ? String(Number(suffix)) : "";
}

function editDistance(left, right) {
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

export function parseItem(text, dictionary) {
    const reading = text.match(/^(.*?)\s+x\s*(?:\d+|[|Il])\s*$/i)?.[1];
    if (!reading) return "";
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
    if (candidates[0]?.distance > 0.35 || candidates[0]?.distance === candidates[1]?.distance) return "";
    return candidates[0]?.item ?? "";
}

export function chooseConsensus(readings) {
    const counts = new Map();
    for (const reading of readings) {
        if (reading === "") continue;
        counts.set(reading, (counts.get(reading) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
    return ranked[0]?.[1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : "";
}

export function chooseTemporalConsensus(readingsByFrame) {
    return chooseConsensus(readingsByFrame.flatMap((readings) => [...new Set(readings.filter(Boolean))]));
}

export function chooseTemporalPairConsensus(readingsByFrame) {
    const pairs = readingsByFrame.map((readings) =>
        readings
            .filter(({ item, quantity }) => item !== "" && quantity !== "")
            .map(({ item, quantity }) => `${item}\0${quantity}`),
    );
    const consensus = chooseTemporalConsensus(pairs);
    if (consensus === "") return { item: "", quantity: "" };
    const [item, quantity] = consensus.split("\0");
    return { item, quantity };
}
