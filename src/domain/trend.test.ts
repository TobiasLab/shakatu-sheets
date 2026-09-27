import { describe, expect, it } from "vitest";
import { netAt, recentRate, trendPoints } from "./trend";

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
});
