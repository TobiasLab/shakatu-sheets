import {
    parseLootItem,
    parseLootQuantity,
    rowBirthCount,
    selectLootOcrObservations,
    stackShifted,
    trackLootRows,
} from "../src/recognition/liveLoot.ts";

export { rowBirthCount, stackShifted };
export const selectOcrObservations = selectLootOcrObservations;
export const trackRowEvents = trackLootRows;

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
    const quantity = parseLootQuantity(text);
    return quantity === null ? "" : String(quantity);
}

export function parseItem(text, dictionary) {
    return parseLootItem(text, dictionary) ?? "";
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
