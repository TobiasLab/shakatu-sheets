const silverFormatter = new Intl.NumberFormat("en");
const compactSilverFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });

export function formatSilver(value: number, compact = false) {
    if (compact) {
        return compactSilverFormatter.format(value);
    }
    return silverFormatter.format(Math.round(value));
}

export function formatDuration(milliseconds: number) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return [hours, minutes, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

const relativeDayFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const shortDateFormatter = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const longDateFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

function startOfDay(timestamp: number) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

export function formatRelativeDay(timestamp: number, now = Date.now()) {
    const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
    if (days >= 0 && days < 7) return relativeDayFormatter.format(-days, "day");
    return new Date(timestamp).getFullYear() === new Date(now).getFullYear()
        ? shortDateFormatter.format(timestamp)
        : longDateFormatter.format(timestamp);
}

export function formatTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}
