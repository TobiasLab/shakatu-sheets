import { type Dispatch, type FormEvent, useEffect, useState } from "react";
import { type DropTemplate, sycraiaLower } from "../data/grindSpots";
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
    const [now, setNow] = useState(Date.now());
    const [selectedDrop, setSelectedDrop] = useState<DropTemplate>(sycraiaLower.trash);
    const [quantity, setQuantity] = useState("1");
    const [unitPrice, setUnitPrice] = useState(String(sycraiaLower.trash.unitPrice));
    const [customName, setCustomName] = useState("");
    const [valuation, setValuation] = useState<Valuation>("vendor");
    const market = useMarketPrices(databaseLoaded, session.region);

    useEffect(() => {
        if (market.marketPrices === null || selectedDrop.marketItemId === undefined) return;
        const snapshot = market.marketPrices.find((price) => price.itemId === selectedDrop.marketItemId);
        setUnitPrice(snapshot ? String(snapshot.basePrice) : "");
    }, [market.marketPrices, selectedDrop]);

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

    return {
        session,
        dispatch,
        databaseLoaded,
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
        addEntry,
        startOrResume,
        market,
    };
}

export type LiveSessionController = ReturnType<typeof useLiveSession>;
