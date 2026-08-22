import { type Dispatch, type FormEvent, useEffect, useState } from "react";
import { type DropTemplate, getGrindSpot, getGrindSpotDrops, getMarketItemIds } from "../data/grindSpots";
import {
    calculateTotals,
    createEntry,
    getElapsedMs,
    type SessionAction,
    type SessionState,
    type Valuation,
} from "../domain/session";
import { useMarketPrices } from "./useMarketPrices";

export function useLiveSession(session: SessionState, dispatch: Dispatch<SessionAction>, databaseLoaded: boolean) {
    const spot = getGrindSpot(session.grindSpotId);
    const drops = getGrindSpotDrops(session.grindSpotId);
    const marketItemIds = getMarketItemIds(session.grindSpotId);
    const [now, setNow] = useState(Date.now());
    const [selectedDrop, setSelectedDrop] = useState<DropTemplate>(spot.trash);
    const [quantity, setQuantity] = useState("1");
    const [unitPrice, setUnitPrice] = useState(String(spot.trash.unitPrice));
    const [customName, setCustomName] = useState("");
    const [valuation, setValuation] = useState<Valuation>("vendor");
    const market = useMarketPrices(databaseLoaded, session.region, session.grindSpotId);

    useEffect(() => {
        if (market.marketPrices === null || selectedDrop.marketItemId === undefined) return;
        const snapshot = market.marketPrices.find((price) => price.itemId === selectedDrop.marketItemId);
        setUnitPrice(snapshot ? String(snapshot.basePrice) : "");
    }, [market.marketPrices, selectedDrop]);

    useEffect(() => {
        setSelectedDrop(spot.trash);
        setQuantity("1");
        setUnitPrice(spot.trash.unitPrice === null ? "" : String(spot.trash.unitPrice));
        setCustomName("");
        setValuation(spot.trash.valuation);
    }, [session.grindSpotId, spot.trash]);

    useEffect(() => {
        if (session.status !== "running") return;
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [session.status]);

    const elapsedMs = getElapsedMs(session, now);
    const totals = calculateTotals(session.entries, elapsedMs);
    const editingDisabled = !databaseLoaded || session.status === "finished";

    function chooseDrop(drop: DropTemplate) {
        setSelectedDrop(drop);
        setCustomName(drop.name);
        setValuation(drop.valuation);
        const savedPrice = market.marketPrices?.find((price) => price.itemId === drop.marketItemId)?.basePrice;
        setUnitPrice(
            savedPrice === undefined ? (drop.unitPrice === null ? "" : String(drop.unitPrice)) : String(savedPrice),
        );
        setQuantity("1");
    }

    function changeRegion(region: SessionState["region"]) {
        market.clearMarketPrices();
        if (selectedDrop.marketItemId !== undefined) setUnitPrice("");
        dispatch({ type: "set-region", region });
    }

    function changeGrindSpot(grindSpotId: string) {
        dispatch({ type: "set-grind-spot", grindSpotId });
    }

    function addEntry(event: FormEvent) {
        event.preventDefault();
        if (session.status === "finished") return;
        const name = customName.trim() || selectedDrop.name;
        const parsedQuantity = Number(quantity);
        const parsedPrice = Number(unitPrice);
        if (
            !name ||
            unitPrice.trim() === "" ||
            !Number.isSafeInteger(parsedQuantity) ||
            parsedQuantity <= 0 ||
            parsedPrice < 0 ||
            !Number.isSafeInteger(parsedPrice) ||
            !Number.isFinite(parsedQuantity)
        )
            return;
        dispatch({ type: "add-entry", entry: createEntry(name, parsedQuantity, parsedPrice, valuation) });
        setQuantity("1");
    }

    function startOrResume() {
        const timestamp = Date.now();
        setNow(timestamp);
        dispatch({ type: session.status === "paused" ? "resume" : "start", now: timestamp });
    }

    function setCompletedHours(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("completedHours");
        if (typeof value !== "string" || value.trim() === "") return;
        const hours = Number(value);
        const elapsedMs = Math.round(hours * 3_600_000);
        if (!Number.isFinite(hours) || hours < 0 || !Number.isSafeInteger(elapsedMs)) return;
        dispatch({ type: "set-elapsed", elapsedMs });
    }

    return {
        session,
        dispatch,
        databaseLoaded,
        spot,
        drops,
        marketItemIds,
        elapsedMs,
        totals,
        editingDisabled,
        selectedDrop,
        quantity,
        setQuantity,
        unitPrice,
        setUnitPrice,
        customName,
        setCustomName,
        valuation,
        setValuation,
        chooseDrop,
        changeRegion,
        changeGrindSpot,
        addEntry,
        startOrResume,
        setCompletedHours,
        market,
    };
}

export type LiveSessionController = ReturnType<typeof useLiveSession>;
