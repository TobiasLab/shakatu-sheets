import { useEffect, useId, useRef, useState } from "react";
import { type GrindSpotProfile, getGrindSpot } from "../../data/grindSpots";
import { Icon } from "../Icon/Icon";
import styles from "./GrindSpotPicker.module.css";
import {
    filterSpots,
    parseSpotPreferences,
    quickSpotIds,
    rememberSpot,
    SPOT_PREFERENCES_KEY,
    type SpotFilter,
    type SpotPreferences,
} from "./preferences";

function readPreferences() {
    try {
        return parseSpotPreferences(localStorage.getItem(SPOT_PREFERENCES_KEY));
    } catch {
        return parseSpotPreferences(null);
    }
}

export function GrindSpotPicker({
    spot,
    disabled,
    onSelect,
}: {
    spot: GrindSpotProfile;
    disabled: boolean;
    onSelect: (id: string) => void;
}) {
    const [preferences, setPreferences] = useState(readPreferences);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<SpotFilter>("All");
    const dialog = useRef<HTMLDialogElement>(null);
    const opener = useRef<HTMLButtonElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const titleId = useId();
    const searchId = useId();
    const results = filterSpots(preferences, filter, query);

    useEffect(() => {
        if (disabled) dialog.current?.close();
    }, [disabled]);

    function save(next: SpotPreferences) {
        setPreferences(next);
        try {
            localStorage.setItem(SPOT_PREFERENCES_KEY, JSON.stringify(next));
        } catch {
            // Preferences remain usable in memory when storage is unavailable.
        }
    }

    function select(id: string) {
        if (disabled) return;
        onSelect(id);
        save(rememberSpot(preferences, id));
        dialog.current?.close();
    }

    function toggleFavorite(id: string) {
        save({
            ...preferences,
            favorites: preferences.favorites.includes(id)
                ? preferences.favorites.filter((favorite) => favorite !== id)
                : [...preferences.favorites, id],
        });
    }

    return (
        <section className={styles.Picker} aria-label="Grind spot">
            <div className={styles.Selected}>
                <img src={spot.trash.icon} alt="" width={40} height={40} />
                <div className={styles.Identity}>
                    <span>Grind spot</span>
                    <h2>{spot.name}</h2>
                </div>
                <button
                    className="button"
                    type="button"
                    ref={opener}
                    disabled={disabled}
                    onClick={() => {
                        setQuery("");
                        setFilter("All");
                        dialog.current?.showModal();
                        search.current?.focus();
                    }}
                >
                    Browse all spots
                </button>
            </div>
            {quickSpotIds(preferences).length > 0 && (
                <section className={styles.Shortcuts} aria-label="Quick access spots">
                    {quickSpotIds(preferences).map((id) => {
                        const quickSpot = getGrindSpot(id);
                        return (
                            <button
                                key={id}
                                type="button"
                                disabled={disabled}
                                aria-pressed={id === spot.id}
                                className={styles.Shortcut}
                                onClick={() => select(id)}
                            >
                                <img src={quickSpot.trash.icon} alt="" width={22} height={22} />
                                <span>{quickSpot.name}</span>
                                {preferences.favorites.includes(id) && <Icon name="star" size={14} />}
                            </button>
                        );
                    })}
                </section>
            )}
            <dialog
                className={styles.Dialog}
                ref={dialog}
                aria-labelledby={titleId}
                onClose={() => opener.current?.focus()}
            >
                <div className={styles.DialogHeader}>
                    <div>
                        <h2 id={titleId}>Choose grind spot</h2>
                        <p>Star your favorites for quick access on the desk.</p>
                    </div>
                    <button
                        className="button"
                        type="button"
                        aria-label="Close spot browser"
                        onClick={() => dialog.current?.close()}
                    >
                        Close
                    </button>
                </div>
                <div className={styles.Search}>
                    <label className="sr-only" htmlFor={searchId}>
                        Search grind spots
                    </label>
                    <input
                        id={searchId}
                        ref={search}
                        type="search"
                        placeholder="Search grind spots…"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    {query && (
                        <button
                            className="button"
                            type="button"
                            onClick={() => {
                                setQuery("");
                                search.current?.focus();
                            }}
                        >
                            Clear search
                        </button>
                    )}
                </div>
                <section className={styles.Filters} aria-label="Spot filters">
                    {(["All", "Favorites", "Recent"] as const).map((value) => (
                        <button
                            type="button"
                            key={value}
                            aria-pressed={filter === value}
                            onClick={() => setFilter(value)}
                        >
                            {value}
                        </button>
                    ))}
                    <span role="status">
                        {results.length} {results.length === 1 ? "spot" : "spots"}
                    </span>
                </section>
                <div className={styles.Results}>
                    {results.length === 0 ? (
                        <p className={styles.Empty}>
                            {query
                                ? "No spots match your search."
                                : filter === "Favorites"
                                  ? "No favorites yet. Star a spot in All to keep it here."
                                  : "No recent spots yet. Choose a spot to get started."}
                        </p>
                    ) : (
                        <ul className={styles.Grid}>
                            {results.map((candidate) => (
                                <li key={candidate.id} className={styles.Tile} data-selected={candidate.id === spot.id}>
                                    <button
                                        className={styles.Choose}
                                        type="button"
                                        disabled={disabled}
                                        aria-pressed={candidate.id === spot.id}
                                        onClick={() => select(candidate.id)}
                                    >
                                        <img src={candidate.trash.icon} alt="" width={36} height={36} loading="lazy" />
                                        <span>
                                            {candidate.name}
                                            {candidate.id === spot.id && <small>Selected</small>}
                                        </span>
                                    </button>
                                    <button
                                        className={styles.Star}
                                        type="button"
                                        aria-label={`${preferences.favorites.includes(candidate.id) ? "Unstar" : "Star"} ${candidate.name}`}
                                        aria-pressed={preferences.favorites.includes(candidate.id)}
                                        onClick={() => toggleFavorite(candidate.id)}
                                    >
                                        <Icon name="star" size={18} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </dialog>
        </section>
    );
}
