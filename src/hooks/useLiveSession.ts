import { type Dispatch, type FormEvent, useEffect, useState } from "react";
import { type DropTemplate, getGrindSpot, getGrindSpotDrops, getMarketItemIds } from "../data/grindSpots";
import { createEntry, type SessionAction, type SessionState, type Valuation } from "../domain/session";
import { useMarketPrices } from "./useMarketPrices";

export function useLiveSession(session: SessionState, dispatch: Dispatch<SessionAction>, databaseLoaded: boolean) {
    const spot = getGrindSpot(session.grindSpotId);
    const drops = getGrindSpotDrops(session.grindSpotId);
    const marketItemIds = getMarketItemIds(session.grindSpotId);
    const [selectedDrop, setSelectedDrop] = useState<DropTemplate>(spot.trash);
    const [quantity, setQuantity] = useState("1");
    const [unitPrice, setUnitPrice] = useState(String(spot.trash.unitPrice));
    const [customName, setCustomName] = useState("");
    const [valuation, setValuation] = useState<Valuation>("vendor");
    const market = useMarketPrices(databaseLoaded, session.region, session.grindSpotId);

    useEffect(() => {
        if (valuation === "expense" || market.marketPrices === null || selectedDrop.marketItemId === undefined) return;
        const snapshot = market.marketPrices.find((price) => price.itemId === selectedDrop.marketItemId);
        setUnitPrice(snapshot ? String(snapshot.basePrice) : "");
    }, [market.marketPrices, selectedDrop, valuation]);

    useEffect(() => {
        setSelectedDrop(spot.trash);
        setQuantity("1");
        setUnitPrice(spot.trash.unitPrice === null ? "" : String(spot.trash.unitPrice));
        setCustomName("");
        setValuation(spot.trash.valuation);
    }, [session.id, session.grindSpotId, spot.trash]);

    const spotEditable = session.status === "idle" && session.elapsedMs === 0 && session.entries.length === 0;
    const editingDisabled = !databaseLoaded || session.status === "finished";

    function dropPrice(drop: DropTemplate) {
        return market.marketPrices?.find((price) => price.itemId === drop.marketItemId)?.basePrice ?? drop.unitPrice;
    }

    function chooseDrop(drop: DropTemplate) {
        setSelectedDrop(drop);
        setCustomName(drop.name);
        setValuation(drop.valuation);
        const price = dropPrice(drop);
        setUnitPrice(price === null ? "" : String(price));
        setQuantity("1");
    }

    function changeRegion(region: SessionState["region"]) {
        market.clearMarketPrices();
        if (valuation !== "expense" && selectedDrop.marketItemId !== undefined) setUnitPrice("");
        dispatch({ type: "set-region", region });
    }

    function changeGrindSpot(grindSpotId: string) {
        dispatch({ type: "set-grind-spot", grindSpotId });
    }

    function addEntry(event: FormEvent): string | null {
        event.preventDefault();
        if (!databaseLoaded) return "Wait for your session to finish loading.";
        if (session.status === "finished") return "This session is finished. Start a new session to add entries.";
        const name = customName.trim() || (valuation === "expense" ? "" : selectedDrop.name);
        const parsedQuantity = Number(quantity);
        const parsedPrice = Number(unitPrice);
        if (
            !name ||
            unitPrice.trim() === "" ||
            !Number.isSafeInteger(parsedQuantity) ||
            parsedQuantity <= 0 ||
            parsedPrice < 0 ||
            !Number.isSafeInteger(parsedPrice)
        )
            return "Enter a name, a positive whole quantity, and a whole silver price of 0 or more.";
        const combinedQuantity = session.entries.reduce(
            (total, entry) =>
                entry.name === name && entry.valuation === valuation && entry.unitPrice === parsedPrice
                    ? total + entry.quantity
                    : total,
            parsedQuantity,
        );
        if (!Number.isSafeInteger(combinedQuantity))
            return "The combined quantity is too large. This entry was not added.";
        dispatch({ type: "add-entry", entry: createEntry(name, parsedQuantity, parsedPrice, valuation) });
        setQuantity("1");
        return null;
    }

    function startOrResume() {
        const timestamp = Date.now();
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
        editingDisabled,
        spotEditable,
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
        dropPrice,
        changeRegion,
        changeGrindSpot,
        addEntry,
        startOrResume,
        setCompletedHours,
        market,
    };
}

export type LiveSessionController = ReturnType<typeof useLiveSession>;
