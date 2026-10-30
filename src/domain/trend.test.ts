import { describe, expect, it } from "vitest";
import {
    hasRecordedTrend,
    netAt,
    recentRate,
    SPIKE_MAX_MARKERS,
    SPIKE_MIN_GAP_SHARE,
    SPIKE_MIN_SHARE_OF_NET,
    spikeAt,
    spikeDrops,
    type TrendDrop,
    trendPoints,
} from "./trend";

describe("session trend", () => {
    const samples = [
        { elapsedMs: 600_000, net: 100 },
        { elapsedMs: 1_800_000, net: 400 },
        { elapsedMs: 5_000_000, net: 999 },
    ];

    it("starts at the origin, keeps samples inside the session and ends at the live value", () => {
        expect(trendPoints(samples, 3_600_000, 700)).toEqual([
            { elapsedMs: 0, net: 0 },
            { elapsedMs: 600_000, net: 100 },
            { elapsedMs: 1_800_000, net: 400 },
            { elapsedMs: 3_600_000, net: 700 },
        ]);
        expect(trendPoints([{ elapsedMs: 0, net: 50 }], 1_000, 50)[0]).toEqual({ elapsedMs: 0, net: 50 });
        expect(trendPoints(samples, 0, 0)).toEqual([{ elapsedMs: 0, net: 0 }]);
    });

    it("interpolates net between samples", () => {
        const points = trendPoints(samples, 3_600_000, 700);
        expect(netAt(points, 300_000)).toBe(50);
        expect(netAt(points, 1_200_000)).toBe(250);
        expect(netAt(points, 9_000_000)).toBe(700);
    });

    it("measures the recent pace only once the window has elapsed", () => {
        const points = trendPoints(samples, 3_600_000, 700);
        expect(recentRate(points, 1_800_000)).toBe(600);
        expect(recentRate(trendPoints([], 900_000, 10), 1_800_000)).toBeNull();
    });

    it("shows a finished session's trend only when it has samples and lasted a minute", () => {
        expect(hasRecordedTrend(samples, 3_600_000)).toBe(true);
        expect(hasRecordedTrend([], 3_600_000)).toBe(false);
        expect(hasRecordedTrend(samples, 59_999)).toBe(false);
        expect(hasRecordedTrend([{ elapsedMs: 0, net: 500 }], 0)).toBe(false);
    });

    describe("spike markers", () => {
        const hour = 3_600_000;
        const net = 1_000_000_000;
        const drop = (elapsedMs: number, value: number, name = "Item"): TrendDrop => ({
            elapsedMs,
            name,
            quantity: 1,
            value,
        });

        it("marks drops worth a meaningful share of the session net, in time order", () => {
            const atThreshold = SPIKE_MIN_SHARE_OF_NET * net;
            expect(
                spikeDrops([drop(hour / 2, atThreshold, "Big"), drop(hour / 4, atThreshold - 1, "Small")], hour, net),
            ).toEqual([drop(hour / 2, atThreshold, "Big")]);
            expect(spikeDrops([drop(hour / 2, 5), drop(hour / 4, 0)], hour, -100)).toEqual([drop(hour / 2, 5)]);
        });

        it("keeps only the most valuable markers and the larger of two close ones", () => {
            const spread = Array.from({ length: SPIKE_MAX_MARKERS + 2 }, (_, index) =>
                drop((index * hour) / (SPIKE_MAX_MARKERS + 2), net / 2 + index),
            );
            const spikes = spikeDrops(spread, hour, net);
            expect(spikes).toHaveLength(SPIKE_MAX_MARKERS);
            expect(spikes.map((spike) => spike.value)).toEqual(spread.slice(2).map((spike) => spike.value));

            const close = SPIKE_MIN_GAP_SHARE * hour - 1;
            expect(spikeDrops([drop(hour / 2, net / 2), drop(hour / 2 + close, net)], hour, net)).toEqual([
                drop(hour / 2 + close, net),
            ]);
            expect(spikeDrops([drop(hour + 1, net)], hour, net)).toEqual([]);
        });

        it("finds the marker nearest a position within half the marker spacing", () => {
            const spikes = [drop(hour / 4, net), drop(hour / 2, net)];
            const reach = (SPIKE_MIN_GAP_SHARE * hour) / 2;
            expect(spikeAt(spikes, hour / 2 - reach, hour)).toBe(spikes[1]);
            expect(spikeAt(spikes, hour / 2 + reach + 1, hour)).toBeNull();
            expect(spikeAt(spikes, hour / 4 + 1, hour)).toBe(spikes[0]);
        });
    });
});
