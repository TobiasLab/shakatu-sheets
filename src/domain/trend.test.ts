import { describe, expect, it } from "vitest";
import {
    hasRecordedTrend,
    netAt,
    PACE_MIN_SPAN_MS,
    PACE_WINDOW_MS,
    paceAt,
    paceSeries,
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
        expect(recentRate(points)).toBe(600);
        expect(recentRate(trendPoints([], 900_000, 10))).toBeNull();
    });

    it("shows a finished session's trend only when it has samples and lasted a minute", () => {
        expect(hasRecordedTrend(samples, 3_600_000)).toBe(true);
        expect(hasRecordedTrend([], 3_600_000)).toBe(false);
        expect(hasRecordedTrend(samples, 59_999)).toBe(false);
        expect(hasRecordedTrend([{ elapsedMs: 0, net: 500 }], 0)).toBe(false);
    });

    describe("pace", () => {
        const hour = 3_600_000;
        const minute = 60_000;
        // 100 silver each minute, plus a 6,000 silver drop in minute 61.
        const perMinute = Array.from({ length: 119 }, (_, index) => ({
            elapsedMs: (index + 1) * minute,
            net: (index + 1) * 100 + (index + 1 >= 61 ? 6_000 : 0),
        }));
        const points = trendPoints(perMinute, 2 * hour, 18_000);

        it("measures silver per hour over the trailing window until a drop leaves it", () => {
            expect(paceAt(points, 50 * minute)).toBe(6_000);
            expect(paceAt(points, 61 * minute)).toBe(18_000);
            expect(paceAt(points, 90 * minute)).toBe(18_000);
            expect(paceAt(points, 91 * minute)).toBe(6_000);
            expect(recentRate(points)).toBe(paceAt(points, 2 * hour));
            expect(recentRate(trendPoints([], 15 * minute, 10))).toBeNull();
        });

        it("holds net between samples, so a drop after a quiet stretch counts when it was recorded", () => {
            const quiet = trendPoints(
                [
                    { elapsedMs: 10 * minute, net: 1_000 },
                    { elapsedMs: 55 * minute, net: 1_001_000 },
                ],
                hour,
                1_001_000,
            );
            expect(paceAt(quiet, 55 * minute - 1)).toBe(0);
            expect(paceAt(quiet, 55 * minute)).toBe(2_000_000);
        });

        it("covers the time since the start, but at least the minimum span, before the window has elapsed", () => {
            expect(paceAt(points, 0)).toBe(0);
            expect(paceAt(points, minute)).toBeCloseTo(100 * (hour / PACE_MIN_SPAN_MS));
            expect(paceAt(points, 20 * minute)).toBeCloseTo(6_000);
        });

        it("draws each jump at its exact time, whatever the session length", () => {
            for (const elapsedMs of [2 * hour, 2 * hour + 1_000]) {
                const series = paceSeries(trendPoints(perMinute, elapsedMs, 18_000), elapsedMs);
                expect(series[0]).toEqual({ elapsedMs: 0, value: 0 });
                expect(series).toContainEqual({ elapsedMs: 61 * minute - 1, value: 6_000 });
                expect(series).toContainEqual({ elapsedMs: 61 * minute, value: 18_000 });
                expect(series).toContainEqual({ elapsedMs: 61 * minute + PACE_WINDOW_MS, value: 6_000 });
                expect(series[series.length - 1].elapsedMs).toBe(elapsedMs);
            }
        });
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
