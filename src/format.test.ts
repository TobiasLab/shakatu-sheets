import { describe, expect, it } from "vitest";
import { formatRelativeDay, formatSilverRate } from "./format";

describe("silver rates", () => {
    it("keeps both decimals so a ticking rate holds its width", () => {
        expect(formatSilverRate(893_700_000)).toBe("893.70M");
        expect(formatSilverRate(893_850_000)).toBe("893.85M");
        expect(formatSilverRate(1_500_000_000)).toBe("1.50B");
        expect(formatSilverRate(-26_000_000)).toBe("-26.00M");
    });
    it("shows whole silver below one thousand", () => {
        expect(formatSilverRate(0)).toBe("0");
        expect(formatSilverRate(999.4)).toBe("999");
    });
    it("never prints a negative zero", () => {
        expect(formatSilverRate(-0.2)).toBe("0");
        expect(formatSilverRate(999.6)).toBe("1,000");
        expect(formatSilverRate(1_000)).toBe("1.00K");
    });
});

describe("relative days", () => {
    const now = new Date(2026, 8, 27, 9, 30).getTime();
    it("uses calendar days rather than elapsed hours", () => {
        expect(formatRelativeDay(new Date(2026, 8, 27, 1).getTime(), now)).toBe("today");
        expect(formatRelativeDay(new Date(2026, 8, 26, 23, 59).getTime(), now)).toBe("yesterday");
        expect(formatRelativeDay(new Date(2026, 8, 24, 12).getTime(), now)).toBe("3 days ago");
    });
    it("falls back to dates after a week", () => {
        expect(formatRelativeDay(new Date(2026, 8, 12).getTime(), now)).toBe("Sep 12");
        expect(formatRelativeDay(new Date(2025, 11, 30).getTime(), now)).toBe("Dec 30, 2025");
    });
});
