import { describe, expect, it } from "vitest";
import {
    AVERAGE_SCALE_FROM_MS,
    averageAt,
    averageScaleFrom,
    averageSeries,
    hasRecordedTrend,
    netAt,
    recentRate,
    SPIKE_MIN_GAP_SHARE,
    SPIKE_MIN_UNIT_VALUE,
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

    describe("silver per hour", () => {
        const hour = 3_600_000;
        const minute = 60_000;
        // 100 silver each minute, plus a 6,000 silver drop in minute 61.
        const perMinute = Array.from({ length: 119 }, (_, index) => ({
            elapsedMs: (index + 1) * minute,
            net: (index + 1) * 100 + (index + 1 >= 61 ? 6_000 : 0),
        }));
        const points = trendPoints(perMinute, 2 * hour, 18_000);

        it("plots the session average up to each moment, ending at the live silver per hour", () => {
            expect(averageAt(points, 0)).toBe(0);
            expect(averageAt(points, 30 * minute)).toBeCloseTo(6_000);
            expect(averageAt(points, 61 * minute)).toBeCloseTo(12_100 / (61 / 60));
            expect(averageAt(points, 2 * hour)).toBe(18_000 / 2);
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
            expect(averageAt(quiet, 30 * minute)).toBe(2_000);
            const series = averageSeries(quiet, hour);
            const before = series.find((point) => point.elapsedMs === 55 * minute - 1);
            expect(before?.value).toBeCloseTo(1_000 / (55 / 60));
            expect(series).toContainEqual({ elapsedMs: 55 * minute, value: averageAt(quiet, 55 * minute) });
            expect(
                series.filter((point) => point.elapsedMs > 10 * minute && point.elapsedMs < 55 * minute),
            ).toHaveLength(8);
        });

        it("draws each sample in place and ends at the session's elapsed time", () => {
            const series = averageSeries(points, 2 * hour);
            expect(series[0].elapsedMs).toBeGreaterThan(0);
            expect(series).toContainEqual({ elapsedMs: 61 * minute, value: averageAt(points, 61 * minute) });
            expect(series[series.length - 1]).toEqual({ elapsedMs: 2 * hour, value: 9_000 });
        });

        it("keeps the first minutes out of the scale, or half of a short session", () => {
            expect(averageScaleFrom(2 * hour)).toBe(AVERAGE_SCALE_FROM_MS);
            expect(averageScaleFrom(4 * minute)).toBe(2 * minute);
        });

        it("measures the last 30 minutes from net held at its latest sample", () => {
            expect(recentRate(points)).toBe(6_000);
            const quiet = trendPoints(
                [
                    { elapsedMs: 10 * minute, net: 1_000 },
                    { elapsedMs: 55 * minute, net: 1_001_000 },
                ],
                hour,
                1_001_000,
            );
            expect(recentRate(quiet)).toBe(2_000_000);
            expect(recentRate(trendPoints([], 15 * minute, 10))).toBeNull();
        });
    });

    describe("spike markers", () => {
        const hour = 3_600_000;
        const rare = SPIKE_MIN_UNIT_VALUE;
        const drop = (elapsedMs: number, value: number, name = "Item", quantity = 1): TrendDrop => ({
            elapsedMs,
            name,
            quantity,
            value,
        });

        it("marks every rare drop, however small its share of the session, in time order", () => {
            const spread = Array.from({ length: 10 }, (_, index) => drop(((index + 0.5) * hour) / 10, rare + index));
            expect(spikeDrops([...spread].reverse(), hour)).toEqual(spread);
        });

        it("judges rarity by the value of one item, not of the stack", () => {
            expect(
                spikeDrops(
                    [
                        drop(hour / 4, rare - 1, "Common"),
                        drop(hour / 2, rare * 3, "Stack", 30),
                        drop((3 * hour) / 4, rare * 2, "Pair", 2),
                    ],
                    hour,
                ),
            ).toEqual([drop((3 * hour) / 4, rare * 2, "Pair", 2)]);
        });

        it("keeps the more valuable of two overlapping markers and ignores drops after the end", () => {
            const close = SPIKE_MIN_GAP_SHARE * hour - 1;
            expect(spikeDrops([drop(hour / 2, rare), drop(hour / 2 + close, rare * 2)], hour)).toEqual([
                drop(hour / 2 + close, rare * 2),
            ]);
            expect(spikeDrops([drop(hour + 1, rare)], hour)).toEqual([]);
        });

        it("finds the marker nearest a position within half the marker spacing", () => {
            const spikes = [drop(hour / 4, rare), drop(hour / 2, rare)];
            const reach = (SPIKE_MIN_GAP_SHARE * hour) / 2;
            expect(spikeAt(spikes, hour / 2 - reach, hour)).toBe(spikes[1]);
            expect(spikeAt(spikes, hour / 2 + reach + 1, hour)).toBeNull();
            expect(spikeAt(spikes, hour / 4 + 1, hour)).toBe(spikes[0]);
        });
    });
});
