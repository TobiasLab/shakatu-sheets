// Synthetic CPU overhead only; this does not measure gameplay OCR accuracy or dropped frames.
import { performance } from "node:perf_hooks";
import { prepareQuantityLearning } from "../src/recognition/quantityLearning.ts";

const profile = { font: "korean", uiScalePercent: 80, sourceWidth: 3440, sourceHeight: 1440 };
const width = 48,
    height = 20;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
        if (x % 7 < 3 || y % 5 < 2) pixels.fill(235, (y * width + x) * 4, (y * width + x) * 4 + 3);
        pixels[(y * width + x) * 4 + 3] = 255;
    }
}
const itemWidth = 300;
const itemPixels = new Uint8ClampedArray(itemWidth * height * 4);
for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < itemWidth - 2; x++) {
        if (x % 7 < 3 || y % 5 < 2) itemPixels.fill(235, (y * itemWidth + x) * 4, (y * itemWidth + x) * 4 + 3);
        itemPixels[(y * itemWidth + x) * 4 + 3] = 255;
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
    pixels: Array.from(pixels, (value, offset) => (offset === 0 ? index : value)),
    itemName: `Item ${index % 5}`,
    itemImage: {
        width: itemWidth,
        height,
        pixels: Array.from(itemPixels, (value, offset) => (offset === 0 ? index : value)),
    },
    quantity: 600 + (index % 5),
    originalQuantity: null,
    originalText: "",
    confirmedAt: index,
    validation: index % 3 === 0,
}));
const before = performance.now();
const model = prepareQuantityLearning({ enabled: true, autoAllow: true, examples });
const prepareMs = performance.now() - before;
const image = { width, height, pixels };
const samples = [];
for (let iteration = 0; iteration < 240; iteration++) {
    const start = performance.now();
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
            itemCrop: `${itemWidth}x${height}`,
            framesPerEvent: 5,
            libraryPreparationMs: +prepareMs.toFixed(3),
            medianEventMs: +samples[Math.floor(samples.length / 2)].toFixed(3),
            p95EventMs: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
            note: "Synthetic matching cost in Node; not gameplay latency or accuracy.",
        },
        null,
        2,
    ),
);
