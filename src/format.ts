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

export function formatTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}
