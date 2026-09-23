// Run with: npx vite-node scripts/sync-grind-spots.mjs [metadata.json]
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
    aphrodonTemple,
    hermesiaInnerCastle,
    magaiaTemple,
    starsEnd,
    supplementalDrops,
    sycraiaLower,
    zephyrosCastle,
} from "../src/data/grindSpots";

const endpoint = "https://api.garmoth.com/api/external/grind-tracker";
const existing = [sycraiaLower, starsEnd, zephyrosCastle, aphrodonTemple, hermesiaInnerCastle, magaiaTemple];
async function download(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    return response;
}
const metadata = process.argv[2]
    ? JSON.parse(await readFile(process.argv[2], "utf8"))
    : await (await download(endpoint)).json();
const icons = new Map();
function drop(key) {
    const item = metadata.drops[key];
    if (!item?.name || !Number.isFinite(item.price)) throw new Error(`Invalid drop ${key}`);
    const suffix = item.img?.endsWith(".png") ? "png" : "webp";
    const icon = item.img ? `/items/garmoth/${item.main_key}.${suffix}` : "/items/artifact.png";
    if (item.img) icons.set(icon, new URL(item.img, "https://assets.garmoth.com/img/").href);
    const enhancement = ["", "PRI: ", "DUO: ", "TRI: ", "TET: ", "PEN: "][item.sub_key];
    if (enhancement === undefined) throw new Error(`Unsupported enhancement ${key}`);
    return {
        name: enhancement + item.name,
        icon,
        garmothKey: key,
        valuation: item.tax === 1 ? "market" : "vendor",
        unitPrice: item.tax === 1 ? null : item.price,
        ...(item.tax === 1 && item.sub_key === 0 ? { marketItemId: item.main_key } : {}),
    };
}
const refreshedSupplementalDrops = supplementalDrops.map((item) => drop(item.garmothKey));
const spots = Object.values(metadata.spots)
    .filter(
        (spot) =>
            spot.spot_type >= 100 &&
            !/\(OLD\)|\(TBD\)/.test(spot.name) &&
            !existing.some((current) => current.garmothId === spot.id),
    )
    .map((spot) => {
        const trashKey = `${spot.trash}_0`;
        if (!spot.drops.some((item) => item.key === trashKey)) throw new Error(`Missing trash for ${spot.name}`);
        const uniqueDrops = [...new Map(spot.drops.map((item) => [item.key, item])).values()];
        const drops = uniqueDrops
            .sort((a, b) => a.sorting - b.sorting)
            .filter((item) => item.key !== trashKey)
            .map((item) => drop(item.key));
        const trash = drop(trashKey);
        const all = [trash, ...drops];
        const counts = new Map();
        for (const item of all) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
        for (const item of all) if (counts.get(item.name) > 1) item.name += ` (${item.garmothKey})`;
        return { id: `garmoth-${spot.id}`, garmothId: spot.id, name: spot.name, trash, drops };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
await mkdir("public/items/garmoth", { recursive: true });
const pending = [...icons];
await Promise.all(
    Array.from({ length: 8 }, async () => {
        while (pending.length) {
            const [path, url] = pending.shift();
            try {
                await access(`public${path}`);
            } catch {
                await writeFile(`public${path}`, Buffer.from(await (await download(url)).arrayBuffer()));
            }
        }
    }),
);
await writeFile("src/data/garmothSpots.json", `${JSON.stringify(spots, null, 4)}\n`);
await writeFile("src/data/supplementalDrops.json", `${JSON.stringify(refreshedSupplementalDrops, null, 4)}\n`);
const mappings = Object.fromEntries(
    [...existing, ...spots].map((spot) => [
        spot.id,
        {
            garmothId: spot.garmothId,
            drops: Object.fromEntries([spot.trash, ...spot.drops].map((item) => [item.name, item.garmothKey])),
        },
    ]),
);
await writeFile("src/data/garmothMappings.json", `${JSON.stringify(mappings, null, 4)}\n`);
console.info(`Imported ${spots.length} additional grind spots and ${icons.size} local icons.`);
