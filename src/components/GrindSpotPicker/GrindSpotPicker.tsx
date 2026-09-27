import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { listFinishedSessions } from "../../api/tauri";
import { type GrindSpotProfile, getGrindSpot } from "../../data/grindSpots";
import { netPerHour, type SpotSummary } from "../../domain/history";
import type { SessionState } from "../../domain/session";
import { formatRelativeDay, formatSilver } from "../../format";
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
    splitSpotName,
} from "./preferences";

function SpotName({ name }: { name: string }) {
    const { base, tag } = splitSpotName(name);
    return (
        <>
            {base}
            {tag && <span className={styles.Tag}>{tag}</span>}
        </>
    );
}

function moveFocus(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null) {
    if (!list || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>("button[data-spot-choose]:enabled")];
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
        event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : event.key === "ArrowDown"
                ? Math.min(buttons.length - 1, current + 1)
                : Math.max(0, current - 1);
    buttons[next].focus();
}

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
    region,
}: {
    compact?: boolean;
    locked?: boolean;
    region?: SessionState["region"];
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
    const [stats, setStats] = useState<Map<string, SpotSummary> | null>(null);
    const [sort, setSort] = useState<"name" | "rate">("name");
    const statsRequest = useRef(0);
    const list = useRef<HTMLUListElement>(null);
    const filtered = filterSpots(preferences, filter, query);
    const rateOf = (id: string) => {
        const summary = stats?.get(id);
        return summary ? netPerHour(summary) : null;
    };
    const results =
        sort === "rate"
            ? [...filtered].sort((a, b) => {
                  const first = rateOf(a.id);
                  const second = rateOf(b.id);
                  if (first === null || second === null) return first === second ? 0 : first === null ? 1 : -1;
                  return second - first;
              })
            : filtered;

    async function loadStats() {
        if (!region) return;
        const request = ++statsRequest.current;
        try {
            const history = await listFinishedSessions({
                region,
                grindSpotId: null,
                finishedFromMs: null,
                finishedBeforeMs: null,
                offset: 0,
                limit: 1,
            });
            if (request === statsRequest.current)
                setStats(new Map(history.spotSummaries.map((summary) => [summary.grindSpotId, summary])));
        } catch {
            // Personal statistics are optional; the browser remains usable without them.
            if (request === statsRequest.current) setStats(null);
        }
    }

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
                            <h2>
                                <SpotName name={spot.name} />
                            </h2>
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
                            void loadStats();
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
                                <span>
                                    <SpotName name={quickSpot.name} />
                                </span>
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
                        onKeyDown={(event) => {
                            if (event.key !== "ArrowDown") return;
                            event.preventDefault();
                            list.current?.querySelector<HTMLButtonElement>("button[data-spot-choose]:enabled")?.focus();
                        }}
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
                    {stats && stats.size > 0 && (
                        <fieldset className="segmented">
                            <legend className="sr-only">Sort spots</legend>
                            <button type="button" aria-pressed={sort === "name"} onClick={() => setSort("name")}>
                                Name
                            </button>
                            <button type="button" aria-pressed={sort === "rate"} onClick={() => setSort("rate")}>
                                Your silver/h
                            </button>
                        </fieldset>
                    )}
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
                        <ul className={styles.List} ref={list} onKeyDown={(event) => moveFocus(event, list.current)}>
                            {results.map((candidate) => {
                                const summary = stats?.get(candidate.id);
                                const rate = summary ? netPerHour(summary) : null;
                                const statsId = `${titleId}-${candidate.id}`;
                                return (
                                    <li
                                        key={candidate.id}
                                        className={styles.Row}
                                        data-selected={candidate.id === spot.id}
                                    >
                                        <SelectionButton
                                            className={styles.Choose}
                                            data-spot-choose
                                            disabled={disabled}
                                            selected={candidate.id === spot.id}
                                            aria-describedby={summary ? statsId : undefined}
                                            onClick={() => select(candidate.id)}
                                        >
                                            <img
                                                src={candidate.trash.icon}
                                                alt=""
                                                width={32}
                                                height={32}
                                                loading="lazy"
                                            />
                                            <span>
                                                <SpotName name={candidate.name} />
                                            </span>
                                        </SelectionButton>
                                        {summary && (
                                            <span className={styles.SpotStats} id={statsId}>
                                                <strong>{rate === null ? "—" : `${formatSilver(rate, true)}/h`}</strong>
                                                <small>
                                                    {summary.sessionCount}{" "}
                                                    {summary.sessionCount === 1 ? "session" : "sessions"} ·{" "}
                                                    {formatRelativeDay(summary.lastFinishedAt)}
                                                </small>
                                            </span>
                                        )}
                                        <button
                                            className={styles.Star}
                                            type="button"
                                            aria-label={`${preferences.favorites.includes(candidate.id) ? "Unstar" : "Star"} ${candidate.name}`}
                                            aria-pressed={preferences.favorites.includes(candidate.id)}
                                            onClick={() => toggleFavorite(candidate.id)}
                                        >
                                            <Icon name="star" size={16} />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </dialog>
        </section>
    );
}
