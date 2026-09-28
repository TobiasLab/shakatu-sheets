// Run with: node scripts/sync-grind-buffs.mjs [metadata.json]
// Kept apart from sync-grind-spots.mjs so a problem in Garmoth's spot data does not block buff updates.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const endpoint = "https://api.garmoth.com/api/external/grind-tracker";
async function download(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    return response;
}
const metadata = process.argv[2]
    ? JSON.parse(await readFile(process.argv[2], "utf8"))
    : await (await download(endpoint)).json();

// Tiers of one buff cannot be combined, so the upload dialog offers each group as a single choice.
const groups = new Map([
    ...[1, 2].map((id) => [id, "loot-scroll"]),
    ...[12, 11, 10, 9, 8].map((id) => [id, "adventurers-luck"]),
    ...[61, 62, 63, 64, 65].map((id) => [id, "node-war-benefit"]),
    ...[215, 51].map((id) => [id, "fortuna"]),
]);
const buffs = [];
await mkdir("public/buffs", { recursive: true });
// Mode 0 buffs apply to grinding; mode 1 buffs are for life skills.
for (const buff of Object.values(metadata.buffs)
    .filter((candidate) => candidate.enabled && candidate.mode === 0)
    .sort((a, b) => a.sort - b.sort || a.id - b.id)) {
    if (
        !Number.isSafeInteger(buff.id) ||
        !buff.name ||
        ![buff.rate, buff.amount].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
        throw new Error(`Invalid buff ${buff.id}`);
    // Buffs without an icon path usually still have one at grind-buffs/<id>.png, as Garmoth's older buffs do.
    const img = buff.img ?? `grind-buffs/${buff.id}.png`;
    let icon = `/buffs/${buff.id}.${img.endsWith(".png") ? "png" : "webp"}`;
    try {
        await access(`public${icon}`);
    } catch {
        // Some icons are missing from Garmoth's asset host; the dialog then shows an empty icon tile.
        const response = await fetch(new URL(img, "https://assets.garmoth.com/img/"));
        if (response.ok) await writeFile(`public${icon}`, Buffer.from(await response.arrayBuffer()));
        else {
            console.warn(`No icon for ${buff.name}: ${response.status}`);
            icon = null;
        }
    }
    buffs.push({
        id: buff.id,
        name: buff.name,
        icon,
        rate: buff.rate,
        uncapped: buff.is_uncapped === 1,
        amount: buff.amount,
        group: groups.get(buff.id) ?? null,
    });
}
for (const id of groups.keys()) {
    if (!buffs.some((buff) => buff.id === id)) throw new Error(`Grouped buff ${id} is no longer available`);
}
await writeFile("src/data/garmothBuffs.json", `${JSON.stringify(buffs, null, 4)}\n`);
console.info(`Imported ${buffs.length} grind buffs, ${buffs.filter((buff) => buff.icon).length} with icons.`);
