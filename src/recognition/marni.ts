import { createWorker, OEM, PSM } from "tesseract.js";
import { type DropTemplate, getGrindSpotDrops } from "../data/grindSpots";

type LootSlot = { x: number; y: number; size: number };
type QuantityReading = { quantity: string; confidence: number };

export type RecognizedMarniItem = {
    slot: number;
    thumbnail: string;
    suggestedDropName: string;
    matchScore: number | null;
    quantity: string;
    quantityConfidence: number;
};

export type MarniRecognition = {
    grindSpotId: string;
    elapsedMs: number | null;
    items: RecognizedMarniItem[];
};

export function parseMarniDuration(text: string): number | null {
    const line = text.match(/time\s*[:;]?([^\n]+)/i)?.[1];
    if (!line) return null;
    const hourMatch = line.match(/(\d+)\s*[lt]?h/i);
    const hours = hourMatch ? Number(hourMatch[1]) : /(?:^|\s)[ilt]*h/i.test(line) ? 1 : 0;
    const minutes = Number(line.match(/(\d+)\s*m/i)?.[1] ?? 0);
    const seconds = Number(line.match(/(\d+)\s*['’]?s/i)?.[1] ?? 0);
    const elapsedMs = (hours * 3_600 + minutes * 60 + seconds) * 1_000;
    return Number.isSafeInteger(elapsedMs) && elapsedMs > 0 ? elapsedMs : null;
}

export function detectGrindSpot(text: string, fallbackId: string): string {
    const normalized = text.toLocaleLowerCase();
    if (normalized.includes("sycraia")) return "sycraia-lower-revamp";
    if (normalized.includes("star") && normalized.includes("end")) return "stars-end-revamp";
    if (/zephyr(?:u|o)s/.test(normalized)) return "zephyros-castle";
    if (normalized.includes("aphrodon")) return "aphrodon-temple";
    if (normalized.includes("hermesia")) return "hermesia-inner-castle";
    if (normalized.includes("magaia")) return "magaia-temple";
    return fallbackId;
}

export function trustedMarniQuantity(quantity: string): string {
    const value = Number(quantity);
    return Number.isSafeInteger(value) && value > 0 ? quantity : "";
}

export function resolveMarniQuantity(primary: string, looksLikeFive: boolean): string {
    return primary === "3" && looksLikeFive ? "5" : primary;
}

export function selectMarniQuantity(readings: QuantityReading[]): QuantityReading {
    const primary = readings[0] ?? { quantity: "", confidence: 0 };
    const groups = new Map<string, QuantityReading[]>();
    let validReadings = 0;
    for (const reading of readings) {
        if (trustedMarniQuantity(reading.quantity) === "") continue;
        validReadings += 1;
        groups.set(reading.quantity, [...(groups.get(reading.quantity) ?? []), reading]);
    }
    const minimumAgreement = Math.max(2, Math.floor(validReadings / 2) + 1);
    const consensus = [...groups.entries()]
        .filter(([, matches]) => matches.length >= minimumAgreement)
        .sort(
            ([, left], [, right]) =>
                right.length - left.length ||
                Math.max(...right.map(({ confidence }) => confidence)) -
                    Math.max(...left.map(({ confidence }) => confidence)),
        )[0];
    if (!consensus) return { ...primary, quantity: trustedMarniQuantity(primary.quantity) };
    const [quantity, matches] = consensus;
    const confidence = matches.reduce((total, match) => total + match.confidence, 0) / matches.length;
    return { quantity, confidence: Math.max(70, confidence) };
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const element = document.createElement("canvas");
    element.width = width;
    element.height = height;
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable.");
    return [element, context];
}

function detectLootSlots(source: HTMLImageElement): LootSlot[] {
    const width = source.naturalWidth;
    const height = source.naturalHeight;
    if (width < 250 || height < 200 || width > 1_200 || height > 1_200) {
        throw new Error("Use a cropped Marni loot tracker screenshot at 80%, 100%, or 120% UI scale.");
    }
    const [, context] = canvas(width, height);
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    return detectMarniLootSlots(pixels, width, height);
}

export function detectMarniLootSlots(pixels: Uint8ClampedArray, width: number, height: number): LootSlot[] {
    const rows = new Uint16Array((width + 1) * height);
    const columns = new Uint16Array(width * (height + 1));
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pixel = (y * width + x) * 4;
            const bright = Math.max(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]) > 65 ? 1 : 0;
            rows[y * (width + 1) + x + 1] = rows[y * (width + 1) + x] + bright;
            columns[(y + 1) * width + x] = columns[y * width + x] + bright;
        }
    }

    let slots: Array<LootSlot & { score: number }> = [];
    for (let size = 56; size >= 34; size -= 1) {
        const candidates: Array<LootSlot & { score: number }> = [];
        for (let y = Math.floor(height * 0.65); y <= height - size; y += 1) {
            for (let x = 0; x <= width - size; x += 1) {
                const top = rows[y * (width + 1) + x + size] - rows[y * (width + 1) + x];
                const bottom = rows[(y + size - 1) * (width + 1) + x + size] - rows[(y + size - 1) * (width + 1) + x];
                const left = columns[(y + size) * width + x] - columns[y * width + x];
                const right = columns[(y + size) * width + x + size - 1] - columns[y * width + x + size - 1];
                const score = (top + bottom + left + right) / (size * 4);
                if (score >= 0.92) candidates.push({ x, y, size, score });
            }
        }
        candidates.sort((left, right) => right.score - left.score);
        const sizeSlots: typeof candidates = [];
        for (const candidate of candidates) {
            const duplicate = sizeSlots.some(
                (slot) =>
                    Math.abs(slot.x + slot.size / 2 - (candidate.x + candidate.size / 2)) < 6 &&
                    Math.abs(slot.y + slot.size / 2 - (candidate.y + candidate.size / 2)) < 6,
            );
            if (!duplicate) sizeSlots.push(candidate);
        }
        const evidence = sizeSlots.reduce((total, slot) => total + slot.score * slot.size, 0);
        const currentEvidence = slots.reduce((total, slot) => total + slot.score * slot.size, 0);
        if (sizeSlots.length <= 18 && evidence > currentEvidence) {
            slots = sizeSlots;
        }
    }
    const result = slots.map(({ x, y, size }) => ({ x, y, size }));
    result.sort((left, right) => left.y - right.y || left.x - right.x);
    if (result.length === 0 || result.length > 18) {
        throw new Error("Could not find the occupied Marni loot slots. Use a cropped 80%, 100%, or 120% screenshot.");
    }
    return result;
}

function cropSlot(source: HTMLImageElement, slotPosition: LootSlot): HTMLCanvasElement {
    const [slot, context] = canvas(44, 44);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, slotPosition.x, slotPosition.y, slotPosition.size, slotPosition.size, 0, 0, 44, 44);
    return slot;
}

function detailsImage(source: HTMLImageElement, firstSlot: LootSlot): HTMLCanvasElement {
    const left = Math.max(0, firstSlot.x - 4);
    const top = Math.max(0, firstSlot.y - Math.round(firstSlot.size * 3.8));
    const width = source.naturalWidth - left * 2;
    const height = Math.min(source.naturalHeight - top, Math.round(firstSlot.size * 2.7));
    const scale = 3;
    const border = 30;
    const [details, context] = canvas(width * scale + border * 2, height * scale + border * 2);
    context.fillStyle = "white";
    context.fillRect(0, 0, details.width, details.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, left, top, width, height, border, border, width * scale, height * scale);
    const pixels = context.getImageData(border, border, width * scale, height * scale);
    for (let index = 0; index < pixels.data.length; index += 4) {
        const luminance = pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114;
        const value = luminance > 140 ? 255 : 0;
        pixels.data[index] = value;
        pixels.data[index + 1] = value;
        pixels.data[index + 2] = value;
        pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, border, border);
    return details;
}

function durationImage(source: HTMLImageElement, firstSlot: LootSlot, threshold: number): HTMLCanvasElement {
    const left = firstSlot.x + Math.round(firstSlot.size * 0.65);
    const top = firstSlot.y - Math.round(firstSlot.size * 3.15);
    const width = Math.min(source.naturalWidth - left, Math.round(firstSlot.size * 5));
    const height = Math.round(firstSlot.size * 0.65);
    const scale = 4;
    const [duration, context] = canvas(width * scale, height * scale);
    context.drawImage(source, left, top, width, height, 0, 0, duration.width, duration.height);
    const pixels = context.getImageData(0, 0, duration.width, duration.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
        const luminance = pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114;
        const value = luminance > threshold ? 255 : 0;
        pixels.data[index] = value;
        pixels.data[index + 1] = value;
        pixels.data[index + 2] = value;
    }
    context.putImageData(pixels, 0, 0);
    return duration;
}

function quantityImage(
    source: HTMLImageElement,
    slot: LootSlot,
    variant = 0,
): { image: HTMLCanvasElement; looksLikeFive: boolean; looksLikeOne: boolean } {
    const settings = [
        { top: 20, height: 15, mode: "color", threshold: 0.5, saturation: 0.3 },
        { top: 18, height: 17, mode: "color", threshold: 0.43, saturation: 0.4 },
        { top: 21, height: 14, mode: "color", threshold: 0.57, saturation: 0.22 },
        { top: 18, height: 17, mode: "grayscale", threshold: 0.55, saturation: 1 },
        { top: 19, height: 16, mode: "grayscale", threshold: 0.7, saturation: 1 },
    ][variant];
    const width = slot.size;
    const height = Math.round((slot.size * settings.height) / 36);
    const top = slot.y + Math.round((slot.size * settings.top) / 36);
    const [mask, maskContext] = canvas(width, height);
    maskContext.drawImage(source, slot.x, top, width, height, 0, 0, width, height);
    const pixels = maskContext.getImageData(0, 0, width, height);

    for (let index = 0; index < pixels.data.length; index += 4) {
        const red = pixels.data[index] / 255;
        const green = pixels.data[index + 1] / 255;
        const blue = pixels.data[index + 2] / 255;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const lightness = (maximum + minimum) / 2;
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        const saturation = maximum === minimum ? 0 : (maximum - minimum) / (1 - Math.abs(maximum + minimum - 1));
        const value =
            settings.mode === "grayscale"
                ? luminance > settings.threshold
                    ? 0
                    : 255
                : lightness > settings.threshold && saturation < settings.saturation
                  ? 0
                  : 255;
        pixels.data[index] = value;
        pixels.data[index + 1] = value;
        pixels.data[index + 2] = value;
        pixels.data[index + 3] = 255;
    }

    const visited = new Uint8Array(width * height);
    const components: Array<{ left: number; right: number; top: number; bottom: number; points: number[] }> = [];
    for (let pixelY = 1; pixelY < height - 1; pixelY += 1) {
        for (let pixelX = 1; pixelX < width - 1; pixelX += 1) {
            const start = pixelY * width + pixelX;
            if (visited[start] || pixels.data[start * 4] !== 0) continue;
            const pending = [start];
            const points: number[] = [];
            visited[start] = 1;
            let left = pixelX;
            let right = pixelX;
            let top = pixelY;
            let bottom = pixelY;
            while (pending.length > 0) {
                const point = pending.pop();
                if (point === undefined) break;
                points.push(point);
                const pointX = point % width;
                const pointY = Math.floor(point / width);
                left = Math.min(left, pointX);
                right = Math.max(right, pointX);
                top = Math.min(top, pointY);
                bottom = Math.max(bottom, pointY);
                for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                        const neighborX = pointX + offsetX;
                        const neighborY = pointY + offsetY;
                        const neighbor = neighborY * width + neighborX;
                        if (
                            neighborX <= 0 ||
                            neighborX >= width - 1 ||
                            neighborY <= 0 ||
                            neighborY >= height - 1 ||
                            visited[neighbor] ||
                            pixels.data[neighbor * 4] !== 0
                        )
                            continue;
                        visited[neighbor] = 1;
                        pending.push(neighbor);
                    }
                }
            }
            const minimumHeight = settings.mode === "grayscale" ? height * 0.3 : height * 0.45;
            if (bottom - top + 1 >= minimumHeight && bottom >= height - Math.ceil(height / 3) && points.length >= 3) {
                components.push({ left, right, top, bottom, points });
            }
        }
    }

    components.sort((left, right) => right.right - left.right);
    const selected: number[] = [];
    const selectedComponents: typeof components = [];
    let leftEdge = width;
    for (const component of components) {
        const componentWidth = component.right - component.left + 1;
        const componentHeight = component.bottom - component.top + 1;
        if (
            selected.length > 0 &&
            (leftEdge - component.right > Math.ceil((width * 5) / 36) || componentWidth > componentHeight)
        )
            break;
        selected.push(...component.points);
        selectedComponents.push(component);
        leftEdge = component.left;
    }
    for (let index = 0; index < pixels.data.length; index += 4) {
        pixels.data[index] = 255;
        pixels.data[index + 1] = 255;
        pixels.data[index + 2] = 255;
    }
    for (const point of selected) {
        pixels.data[point * 4] = 0;
        pixels.data[point * 4 + 1] = 0;
        pixels.data[point * 4 + 2] = 0;
    }
    maskContext.putImageData(pixels, 0, 0);

    const [scaled, scaledContext] = canvas(width * 10 + 100, height * 10 + 100);
    scaledContext.fillStyle = "white";
    scaledContext.fillRect(0, 0, scaled.width, scaled.height);
    scaledContext.imageSmoothingEnabled = true;
    scaledContext.imageSmoothingQuality = "high";
    scaledContext.drawImage(mask, 50, 50, width * 10, height * 10);
    const digit = selectedComponents[0];
    let looksLikeFive = false;
    let looksLikeOne = false;
    if (selectedComponents.length === 1 && digit) {
        const digitWidth = digit.right - digit.left + 1;
        const digitHeight = digit.bottom - digit.top + 1;
        looksLikeOne = digitWidth <= digitHeight * 0.55;
        if (digitWidth <= digitHeight) {
            let upperLeft = 0;
            let upperRight = 0;
            for (const point of digit.points) {
                const pointX = point % width;
                const pointY = Math.floor(point / width);
                if (pointY < digit.top + digitHeight * 0.2 || pointY > digit.top + digitHeight * 0.55) continue;
                if (pointX < digit.left + digitWidth * 0.45) upperLeft += 1;
                if (pointX > digit.left + digitWidth * 0.55) upperRight += 1;
            }
            looksLikeFive = upperLeft > upperRight;
        }
    }
    return { image: scaled, looksLikeFive, looksLikeOne };
}

async function loadIcon(drop: DropTemplate): Promise<ImageData> {
    const image = new Image();
    image.src = drop.icon;
    await image.decode().catch((error) => {
        throw new Error(`Could not decode ${drop.icon}: ${error}`);
    });
    const [, context] = canvas(44, 31);
    context.fillStyle = "#080808";
    context.fillRect(0, 0, 44, 31);
    context.drawImage(image, 0, 0, 44, 44);
    return context.getImageData(0, 0, 44, 31);
}

function imageDistance(left: ImageData, right: ImageData): number {
    let squaredError = 0;
    for (let index = 0; index < left.data.length; index += 4) {
        squaredError += (left.data[index] - right.data[index]) ** 2;
        squaredError += (left.data[index + 1] - right.data[index + 1]) ** 2;
        squaredError += (left.data[index + 2] - right.data[index + 2]) ** 2;
    }
    return Math.sqrt(squaredError / ((left.data.length / 4) * 3)) / 255;
}

function slotIconImage(slot: HTMLCanvasElement, offsetX = 0, offsetY = 0): ImageData {
    const [, context] = canvas(44, 31);
    context.fillStyle = "#080808";
    context.fillRect(0, 0, 44, 31);
    context.drawImage(slot, offsetX, offsetY, 44, 44);
    return context.getImageData(0, 0, 44, 31);
}

function retryIconCandidate(
    slot: HTMLCanvasElement,
    references: Array<{ drop: DropTemplate; image: ImageData }>,
    remainingIcons: Set<number>,
): { icon: number; score: number; votes: number } | undefined {
    const votes = new Map<number, { count: number; margins: number[] }>();
    const variants = [
        slotIconImage(slot, -1, 0),
        slotIconImage(slot, 1, 0),
        slotIconImage(slot, 0, -1),
        slotIconImage(slot, 0, 1),
        slotIconImage(slot),
    ];
    const scores = variants.map((image) =>
        [...remainingIcons]
            .map((icon) => ({ icon, score: imageDistance(image, references[icon].image) }))
            .sort((left, right) => left.score - right.score),
    );
    for (const candidates of scores) {
        const best = candidates[0];
        if (!best) continue;
        const vote = votes.get(best.icon) ?? { count: 0, margins: [] };
        vote.count += 1;
        vote.margins.push((candidates[1]?.score ?? 1) - best.score);
        votes.set(best.icon, vote);
    }
    return [...votes.entries()]
        .filter(([, vote]) => vote.count >= 3)
        .map(([icon, vote]) => ({
            icon,
            votes: vote.count,
            score:
                scores.reduce(
                    (total, candidates) =>
                        total + (candidates.find((candidate) => candidate.icon === icon)?.score ?? 1),
                    0,
                ) / scores.length,
            margin: vote.margins.reduce((total, margin) => total + margin, 0) / vote.margins.length,
        }))
        .filter((candidate) => candidate.score <= 0.32 && candidate.margin >= 0.004)
        .sort((left, right) => right.votes - left.votes || left.score - right.score)[0];
}

async function matchDrops(slots: HTMLCanvasElement[], grindSpotId: string) {
    const uniqueDrops = new Map<string, DropTemplate>();
    for (const drop of getGrindSpotDrops(grindSpotId)) {
        if (!uniqueDrops.has(drop.icon)) uniqueDrops.set(drop.icon, drop);
    }
    const drops = [...uniqueDrops.values()];
    const references = await Promise.all(drops.map(async (drop) => ({ drop, image: await loadIcon(drop) })));
    const remainingSlots = new Set(slots.map((_, index) => index));
    const remainingIcons = new Set(references.map((_, index) => index));
    const matches = new Map<number, { drop: DropTemplate; score: number }>();

    while (remainingSlots.size > 0 && remainingIcons.size > 0) {
        let next: { slot: number; icon: number; score: number; margin: number } | undefined;
        for (const slot of remainingSlots) {
            const image = slotIconImage(slots[slot]);
            const candidates = [...remainingIcons]
                .map((icon) => ({ icon, score: imageDistance(image, references[icon].image) }))
                .sort((left, right) => left.score - right.score);
            const candidate = {
                slot,
                icon: candidates[0].icon,
                score: candidates[0].score,
                margin: (candidates[1]?.score ?? 1) - candidates[0].score,
            };
            if (!next || candidate.score < next.score) next = candidate;
        }
        if (!next || next.score > 0.25) break;
        remainingSlots.delete(next.slot);
        if (next.margin < 0.008) continue;
        remainingIcons.delete(next.icon);
        matches.set(next.slot, { drop: references[next.icon].drop, score: next.score });
    }

    const retrySlots = new Set(slots.map((_, index) => index).filter((index) => !matches.has(index)));
    while (retrySlots.size > 0 && remainingIcons.size > 0) {
        let next: { slot: number; icon: number; score: number; votes: number } | undefined;
        for (const slot of retrySlots) {
            const candidate = retryIconCandidate(slots[slot], references, remainingIcons);
            if (
                candidate &&
                (!next ||
                    candidate.votes > next.votes ||
                    (candidate.votes === next.votes && candidate.score < next.score))
            ) {
                next = { slot, ...candidate };
            }
        }
        if (!next) break;
        retrySlots.delete(next.slot);
        remainingIcons.delete(next.icon);
        matches.set(next.slot, { drop: references[next.icon].drop, score: next.score });
    }
    return matches;
}

export async function recognizeMarniScreenshot(
    file: File,
    fallbackGrindSpotId: string,
    onProgress: (message: string, progress: number) => void,
): Promise<MarniRecognition> {
    const source = new Image();
    const sourceUrl = URL.createObjectURL(file);
    source.src = sourceUrl;
    try {
        await source.decode().catch((error) => {
            throw new Error(`Could not decode screenshot: ${error}`);
        });
    } finally {
        URL.revokeObjectURL(sourceUrl);
    }
    const slotPositions = detectLootSlots(source);
    const slots = slotPositions.map((slot) => cropSlot(source, slot));
    const ocrBase = new URL("ocr/", document.baseURI);
    onProgress("Loading local OCR model", 0.02);
    const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: new URL("worker.min.js", ocrBase).href,
        corePath: new URL("tesseract-core-simd-lstm.wasm.js", ocrBase).href,
        langPath: ocrBase.href,
        cacheMethod: "none",
        gzip: true,
    });

    try {
        onProgress("Reading session details", 0.1);
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
        const metadata = await worker.recognize(detailsImage(source, slotPositions[0])).catch((error) => {
            throw new Error(`Could not read screenshot details: ${error}`);
        });
        const durationReadings = [parseMarniDuration(metadata.data.text)];
        await worker.setParameters({
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            tessedit_char_whitelist: "0123456789hms",
        });
        for (const threshold of [90, 110, 130]) {
            const duration = await worker
                .recognize(durationImage(source, slotPositions[0], threshold))
                .catch((error) => {
                    throw new Error(`Could not read screenshot duration: ${error}`);
                });
            durationReadings.push(parseMarniDuration(`Time: ${duration.data.text}`));
        }
        const elapsedMs = durationReadings.find(
            (reading) => reading !== null && durationReadings.filter((candidate) => candidate === reading).length >= 2,
        );
        await worker.setParameters({
            tessedit_char_whitelist: "0123456789",
        });
        const quantities: QuantityReading[] = [];
        for (let index = 0; index < slots.length; index += 1) {
            onProgress(`Reading loot ${index + 1} of ${slots.length}`, 0.15 + (index / slots.length) * 0.7);
            const quantity = quantityImage(source, slotPositions[index]);
            await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
            const primary = await worker.recognize(quantity.image).catch((error) => {
                throw new Error(`Could not read loot ${index + 1}: ${error}`);
            });
            const primaryText = primary.data.text.replace(/\D/g, "");
            const resolved = resolveMarniQuantity(primaryText, quantity.looksLikeFive);
            const readings = [
                {
                    quantity: resolved,
                    confidence: primary.data.confidence,
                },
            ];
            if (trustedMarniQuantity(resolved) === "" || primary.data.confidence < 70) {
                onProgress(
                    `Rechecking loot ${index + 1} of ${slots.length}`,
                    0.15 + ((index + 0.8) / slots.length) * 0.7,
                );
                for (let variant = 1; variant <= 4; variant += 1) {
                    const retryQuantity = quantityImage(source, slotPositions[index], variant);
                    await worker.setParameters({
                        tessedit_pageseg_mode:
                            variant === 1 ? PSM.SINGLE_LINE : variant === 4 ? PSM.RAW_LINE : PSM.SINGLE_WORD,
                    });
                    const retry = await worker.recognize(retryQuantity.image).catch((error) => {
                        throw new Error(`Could not recheck loot ${index + 1}: ${error}`);
                    });
                    readings.push({
                        quantity: resolveMarniQuantity(retry.data.text.replace(/\D/g, ""), retryQuantity.looksLikeFive),
                        confidence: retry.data.confidence,
                    });
                }
            }
            const selected = selectMarniQuantity(readings);
            quantities.push(
                selected.quantity === "" && quantity.looksLikeOne
                    ? { quantity: "1", confidence: primary.data.confidence }
                    : selected,
            );
        }

        onProgress("Matching item icons", 0.9);
        const grindSpotId = detectGrindSpot(metadata.data.text, fallbackGrindSpotId);
        const matches = await matchDrops(slots, grindSpotId).catch((error) => {
            throw new Error(`Could not match item icons: ${error}`);
        });
        return {
            grindSpotId,
            elapsedMs: elapsedMs ?? durationReadings[0],
            items: slots.map((slot, index) => ({
                slot: index,
                thumbnail: slot.toDataURL("image/png"),
                suggestedDropName: matches.get(index)?.drop.name ?? "",
                matchScore: matches.get(index)?.score ?? null,
                quantity: trustedMarniQuantity(quantities[index].quantity),
                quantityConfidence: quantities[index].confidence,
            })),
        };
    } finally {
        await worker.terminate();
    }
}
