import { useEffect, useState } from "react";
import {
    fetchMarketPrices as fetchMarketPriceSnapshots,
    loadMarketPrices,
    type MarketPriceSnapshot,
} from "../api/tauri";
import { sycraiaMarketItemIds } from "../data/grindSpots";
import type { SessionState } from "../domain/session";

export function useMarketPrices(databaseLoaded: boolean, region: SessionState["region"]) {
    const [marketPrices, setMarketPrices] = useState<MarketPriceSnapshot[] | null>(null);
    const [marketPriceRegion, setMarketPriceRegion] = useState<SessionState["region"] | null>(null);
    const [marketError, setMarketError] = useState("");
    const [fetchingPrices, setFetchingPrices] = useState(false);

    useEffect(() => {
        if (!databaseLoaded) return;

        let cancelled = false;
        setMarketPrices(null);
        setMarketPriceRegion(null);
        setMarketError("");

        async function loadSavedPrices() {
            try {
                const saved = await loadMarketPrices(region);
                const profilePrices = saved.filter((price) => sycraiaMarketItemIds.includes(price.itemId));
                if (profilePrices.length > 0) {
                    if (cancelled) return;
                    setMarketPrices(profilePrices);
                    setMarketPriceRegion(region);
                    return;
                }

                const fallbackRegion = region === "eu" ? "na" : "eu";
                const fallbackSaved = await loadMarketPrices(fallbackRegion);
                const fallbackPrices = fallbackSaved.filter((price) => sycraiaMarketItemIds.includes(price.itemId));
                if (cancelled) return;
                setMarketPrices(fallbackPrices);
                setMarketPriceRegion(fallbackPrices.length > 0 ? fallbackRegion : null);
            } catch (error) {
                if (cancelled) return;
                setMarketPrices([]);
                setMarketPriceRegion(null);
                setMarketError(`Could not read saved prices: ${String(error)}`);
            }
        }

        loadSavedPrices();
        return () => {
            cancelled = true;
        };
    }, [databaseLoaded, region]);

    const currentMarketPrices = (marketPrices ?? []).filter((price) => sycraiaMarketItemIds.includes(price.itemId));
    const lastPriceFetch = currentMarketPrices.reduce((latest, price) => Math.max(latest, price.fetchedAt), 0);
    const usingFallbackPrices = marketPriceRegion !== null && marketPriceRegion !== region;

    async function fetchMarketPrices() {
        setFetchingPrices(true);
        setMarketError("");
        try {
            const snapshots = await fetchMarketPriceSnapshots(region, sycraiaMarketItemIds);
            setMarketPrices(snapshots);
            setMarketPriceRegion(region);
        } catch (error) {
            const prefix =
                currentMarketPrices.length > 0 ? "Refresh failed; saved prices are unchanged. " : "Fetch failed. ";
            setMarketError(`${prefix}${String(error)}`);
        } finally {
            setFetchingPrices(false);
        }
    }

    function clearMarketPrices() {
        setMarketPrices(null);
        setMarketPriceRegion(null);
    }

    return {
        marketPrices,
        marketPriceRegion,
        marketError,
        fetchingPrices,
        currentMarketPrices,
        lastPriceFetch,
        usingFallbackPrices,
        fetchMarketPrices,
        clearMarketPrices,
    };
}
