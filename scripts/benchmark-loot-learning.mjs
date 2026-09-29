// Synthetic CPU overhead only; this does not measure gameplay OCR accuracy or dropped frames.
import { performance } from "node:perf_hooks";
import { prepareQuantityLearning } from "../src/recognition/quantityLearning.ts";

const profile = { font: "korean", uiScalePercent: 80, sourceWidth: 3440, sourceHeight: 1440 };
// Crop sizes seen in recorded 3440 × 1440 captures: two-digit quantities are about 21 × 16 and item names are
// 150–280 pixels wide. Every item label has its own width, as different names do in the game.
const width = 21,
    height = 16,
    itemWidths = [150, 180, 210, 240, 280];
let seed = 1;
function random() {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
}
// Text-like strokes for a label, with per-example noise so no two stored images are identical.
function crop(cropWidth, label) {
    const pixels = new Uint8ClampedArray(cropWidth * height * 4);
    for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < cropWidth - 2; x++) {
            const stroke = (x + label * 3) % 7 < 2 || (y + label) % 9 < 2;
            const value = stroke ? 200 + Math.floor(random() * 55) : Math.floor(random() * 40);
            pixels.fill(value, (y * cropWidth + x) * 4, (y * cropWidth + x) * 4 + 3);
        }
    }
    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
    return pixels;
}
const examples = Array.from({ length: 200 }, (_, index) => ({
    id: `example-${index}`,
    profile: {
        ...profile,
        font: index < 100 ? "korean" : "strong-sword",
        uiScalePercent: Math.floor(index / 50) % 2 === 0 ? 80 : 100,
    },
    width,
    height,
    pixels: Array.from(crop(width, index % 5)),
    itemName: `Item ${index % 5}`,
    itemImage: {
        width: itemWidths[index % 5],
        height,
        pixels: Array.from(crop(itemWidths[index % 5], index % 5)),
    },
    quantity: 600 + (index % 5),
    originalQuantity: null,
    originalText: "",
    confirmedAt: index,
}));
// Every learning command returns the whole library to the frontend as JSON.
let start = performance.now();
const payload = JSON.stringify({ enabled: true, autoAllow: true, examples, unreadable: [] });
const stringifyMs = performance.now() - start;
start = performance.now();
JSON.parse(payload);
const parseMs = performance.now() - start;
const pixels = crop(width, 2);
const itemWidth = itemWidths[2];
const itemPixels = crop(itemWidth, 2);
const before = performance.now();
const model = prepareQuantityLearning({ enabled: true, autoAllow: true, examples });
const prepareMs = performance.now() - before;
const image = { width, height, pixels };
const samples = [];
for (let iteration = 0; iteration < 240; iteration++) {
    start = performance.now();
    for (let frame = 0; frame < 5; frame++) {
        model.suggest(image, profile);
        model.suggestItem({ width: itemWidth, height, pixels: itemPixels }, profile, [
            "Item 0",
            "Item 1",
            "Item 2",
            "Item 3",
            "Item 4",
        ]);
    }
    if (iteration >= 40) samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
console.info(
    JSON.stringify(
        {
            examples: examples.length,
            activeSetupExamples: 50,
            quantityCrop: `${width}x${height}`,
            itemCrops: itemWidths.map((itemWidth) => `${itemWidth}x${height}`),
            framesPerEvent: 5,
            payloadMegabytes: +(payload.length / 1e6).toFixed(1),
            jsonStringifyMs: +stringifyMs.toFixed(1),
            jsonParseMs: +parseMs.toFixed(1),
            libraryPreparationMs: +prepareMs.toFixed(3),
            medianEventMs: +samples[Math.floor(samples.length / 2)].toFixed(3),
            p95EventMs: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
            note: "Synthetic matching cost in Node; not gameplay latency or accuracy.",
        },
        null,
        2,
    ),
);
