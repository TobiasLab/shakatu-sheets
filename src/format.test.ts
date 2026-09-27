import { describe, expect, it } from "vitest";
import { formatRelativeDay } from "./format";

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
