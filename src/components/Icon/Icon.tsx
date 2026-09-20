type IconName =
    | "star"
    | "lock"
    | "brand"
    | "capture"
    | "desk"
    | "history"
    | "settings"
    | "plus"
    | "upload"
    | "arrow"
    | "trash"
    | "play"
    | "pause";

const paths: Record<IconName, string> = {
    star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z",
    lock: "M6 10h12v11H6z M8 10V7a4 4 0 0 1 8 0v3",
    brand: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h4",
    capture: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z",
    desk: "M4 5h16v14H4z M4 9h16 M9 9v10",
    history: "M3 11a9 9 0 1 1 2.5 7 M3 4v7h7 M12 7v5l3 2",
    settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    plus: "M12 5v14 M5 12h14",
    play: "M8 5l11 7-11 7z",
    pause: "M7 5h3v14H7z M14 5h3v14h-3z",
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
