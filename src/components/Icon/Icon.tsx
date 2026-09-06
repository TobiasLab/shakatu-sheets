type IconName = "desk" | "history" | "settings" | "plus" | "upload" | "arrow" | "trash";

const paths: Record<IconName, string> = {
    desk: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    history: "M3 11a9 9 0 1 1 2.5 7 M3 4v7h7 M12 7v5l3 2",
    settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    plus: "M12 5v14 M5 12h14",
    upload: "M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={paths[name]} />
        </svg>
    );
}
