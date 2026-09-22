import { useEffect, useId, useRef, useState } from "react";
import { type GrindSpotProfile, getGrindSpot } from "../../data/grindSpots";
import { DialogHeader } from "../Dialog/DialogHeader";
import { Icon } from "../Icon/Icon";
import { SelectionButton } from "../SelectionButton/SelectionButton";
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
    compact = false,
    locked = false,
}: {
    compact?: boolean;
    locked?: boolean;
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
        else setPreferences(readPreferences());
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
        <section className={compact ? styles.CompactPicker : styles.Picker} aria-label="Grind spot">
            <div className={styles.Selected}>
                {!compact && (
                    <>
                        <img src={spot.trash.icon} alt="" width={40} height={40} />
                        <div className={styles.Identity}>
                            <span>Grind spot</span>
                            <h2>{spot.name}</h2>
                        </div>
                    </>
                )}
                {locked ? (
                    <span className={styles.LockNote}>
                        <Icon name="lock" size={14} />
                        Grind spot locked for this session
                    </span>
                ) : (
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
                )}
            </div>
            {!compact && !locked && quickSpotIds(preferences).length > 0 && (
                <section className={styles.Shortcuts} aria-label="Quick access spots">
                    {quickSpotIds(preferences).map((id) => {
                        const quickSpot = getGrindSpot(id);
                        return (
                            <SelectionButton
                                key={id}
                                disabled={disabled}
                                selected={id === spot.id}
                                className={styles.Shortcut}
                                onClick={() => select(id)}
                            >
                                <img src={quickSpot.trash.icon} alt="" width={22} height={22} />
                                <span>{quickSpot.name}</span>
                                {preferences.favorites.includes(id) && <Icon name="star" size={14} />}
                            </SelectionButton>
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
                <DialogHeader
                    titleId={titleId}
                    title="Choose grind spot"
                    closeLabel="Close spot browser"
                    onClose={() => dialog.current?.close()}
                />
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
                        <SelectionButton key={value} selected={filter === value} onClick={() => setFilter(value)}>
                            {value}
                        </SelectionButton>
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
                                    <SelectionButton
                                        className={styles.Choose}
                                        disabled={disabled}
                                        selected={candidate.id === spot.id}
                                        onClick={() => select(candidate.id)}
                                    >
                                        <img src={candidate.trash.icon} alt="" width={36} height={36} loading="lazy" />
                                        <span>
                                            {candidate.name}
                                            {candidate.id === spot.id && <small>Selected</small>}
                                        </span>
                                    </SelectionButton>
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
