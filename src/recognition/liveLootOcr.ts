import { createWorker, OEM, PSM } from "tesseract.js";
import type { LiveLootOcrFrame, LiveLootOcrReader, LootOcrBounds, LootRoiFrame } from "./liveLoot";
import type { LootFont } from "./lootFont";
import { writeAntialiasedLootPixels } from "./lootOcrPixels";
import { parseLootQuantity } from "./lootReadings";

export type LootOcrThreshold = 130 | 150 | 170;

const thresholds: readonly LootOcrThreshold[] = [130, 150, 170];
const maximumOcrImageBytes = 16 * 1024 * 1024;

export function preprocessLootOcrFrame(
    frame: LootRoiFrame,
    centerY: number,
    threshold: LootOcrThreshold,
    bounds?: LootOcrBounds,
    textColor: "white" | "gold" = "white",
    scale: 2 | 4 = textColor === "gold" ? 4 : 2,
    antialiased = textColor !== "gold",
): LootRoiFrame {
    const { width, height, pixels } = frame;
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
        throw new Error("Loot OCR source dimensions must be positive integers.");
    }
    const expectedLength = width * height * 4;
    if (
        !Number.isSafeInteger(expectedLength) ||
        !(pixels instanceof Uint8ClampedArray) ||
        pixels.length !== expectedLength
    ) {
        throw new Error("Loot OCR source pixels must be tightly packed RGBA data.");
    }
    if (!Number.isSafeInteger(centerY) || !Number.isSafeInteger(centerY - 12) || !Number.isSafeInteger(centerY + 12)) {
        throw new Error("Loot OCR row center must be a safe integer.");
    }
    if (!thresholds.includes(threshold)) throw new Error("Loot OCR threshold must be 130, 150, or 170.");

    const left = bounds?.left ?? Math.round(width * 0.25);
    const right = bounds?.right ?? Math.round(width * 0.8);
    const top = bounds?.top ?? centerY - 12;
    const bottom = bounds?.bottom ?? centerY + 12;
    if (
        !Number.isInteger(left) ||
        !Number.isInteger(right) ||
        !Number.isInteger(top) ||
        !Number.isInteger(bottom) ||
        left < 0 ||
        left >= right ||
        right > width ||
        top >= bottom ||
        (bounds !== undefined && (top < 0 || bottom > height))
    ) {
        throw new Error("Loot OCR bounds must be valid source pixel coordinates.");
    }
    if (scale !== 2 && scale !== 4) throw new Error("Loot OCR enlargement must be 2 or 4.");
    const padding = 10;
    const outputWidth = (right - left) * scale + padding * 2;
    const outputHeight = (bottom - top) * scale + padding * 2;
    const outputBytes = outputWidth * outputHeight * 4;
    if (!Number.isSafeInteger(outputBytes) || outputBytes > maximumOcrImageBytes) {
        throw new Error("Loot OCR output dimensions are too large.");
    }
    const output = new Uint8ClampedArray(outputBytes);
    output.fill(255);
    if (antialiased) {
        writeAntialiasedLootPixels(frame, { left, right, top, bottom }, threshold, scale, output, outputWidth);
        return { width: outputWidth, height: outputHeight, pixels: output };
    }

    for (let y = top; y < bottom; y += 1) {
        if (y < 0 || y >= height) continue;
        for (let x = left; x < right; x += 1) {
            if (x < 0 || x >= width) continue;
            const sourceOffset = (y * width + x) * 4;
            const red = pixels[sourceOffset];
            const green = pixels[sourceOffset + 1];
            const blue = pixels[sourceOffset + 2];
            const luminance = (red * 77 + green * 150 + blue * 29) >> 8;
            const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
            if (luminance < threshold || chroma > (textColor === "gold" ? 140 : 65)) continue;

            const targetLeft = padding + (x - left) * scale;
            const targetTop = padding + (y - top) * scale;
            for (let scaledY = 0; scaledY < scale; scaledY += 1) {
                for (let scaledX = 0; scaledX < scale; scaledX += 1) {
                    const targetOffset = ((targetTop + scaledY) * outputWidth + targetLeft + scaledX) * 4;
                    output[targetOffset] = 0;
                    output[targetOffset + 1] = 0;
                    output[targetOffset + 2] = 0;
                }
            }
        }
    }

    return { width: outputWidth, height: outputHeight, pixels: output };
}

export async function readLootOcrFrame(
    textColor: "white" | "gold" | undefined,
    recognize: (threshold: LootOcrThreshold, scale: 2 | 4, region: "line" | "quantity") => Promise<string>,
    quantityAvailable = false,
    font: LootFont = "korean",
): Promise<string[]> {
    async function read(scale: 2 | 4) {
        const readings: string[] = [];
        for (const threshold of thresholds) readings.push(await recognize(threshold, scale, "line"));
        return readings;
    }

    const readings = await read(textColor === "gold" || font === "strong-sword" ? 4 : 2);
    if (textColor === "gold") return readings;
    const quantities = readings.map(parseLootQuantity);
    const repeatedQuantity = quantities.some(
        (quantity) => quantity !== null && quantities.filter((other) => other === quantity).length > 1,
    );
    if (font === "korean" && repeatedQuantity && new Set(quantities.filter((quantity) => quantity !== null)).size > 1) {
        const retried = await read(4);
        const quantity = parseLootQuantity(retried[0]);
        // Repeated threshold errors can tie quantities across frames. A unanimous larger line can resolve
        // the conflict; otherwise the isolated digits must corroborate both line sizes.
        if (
            quantity !== null &&
            quantities.includes(quantity) &&
            retried.every((text) => parseLootQuantity(text) === quantity)
        )
            return retried;
        const candidates = retried.filter((text) => {
            const value = parseLootQuantity(text);
            return value !== null && quantities.includes(value);
        });
        if (!quantityAvailable || candidates.length === 0) return readings;
        const digits: string[] = [];
        for (const threshold of thresholds) digits.push((await recognize(threshold, 4, "quantity")).trim());
        const recovered = Number(digits[0]);
        if (
            !digits.every((text) => /^\d+$/.test(text) && Number(text) === recovered) ||
            !Number.isSafeInteger(recovered) ||
            recovered <= 0
        )
            return readings;
        // Keep only actual line readings corroborated by all three isolated-digit passes. Returning the
        // supported lines also retains their item text and the temporal veto on conflicting frame pairs.
        const supported = candidates.filter((text) => parseLootQuantity(text) === recovered);
        return supported.length ? supported : readings;
    }
    if (repeatedQuantity) return readings;

    const retried = font === "strong-sword" ? readings : await read(4);
    const chosen = retried.some((text) => parseLootQuantity(text) !== null) ? retried : readings;
    const parsed = chosen.map(parseLootQuantity);
    const independentQuantity =
        font === "strong-sword" &&
        parsed.every((value) => value === null) &&
        chosen.every((text) => /\s+x\s*[^x]*$/i.test(text));
    if (
        !quantityAvailable ||
        (parsed.every((value) => value === null) && !independentQuantity) ||
        !chosen.some((text) => parseLootQuantity(text) === null && /\s+x\s*[^x]*$/i.test(text)) ||
        parsed.some((value) => value !== null && parsed.filter((other) => other === value).length > 1)
    )
        return chosen;
    const digits: number[] = [];
    for (const threshold of thresholds) {
        const text = (await recognize(threshold, 4, "quantity")).trim();
        if (/^\d+$/.test(text)) {
            const value = Number(text);
            if (Number.isSafeInteger(value) && value > 0) digits.push(value);
        }
    }
    // Strong Sword can recover an unreadable suffix only with unanimous digit reads. Temporal consensus still
    // checks the recovered item/quantity pair across frames. Existing numeric readings are never overwritten.
    const quantity = independentQuantity
        ? digits.length === thresholds.length && digits.every((value) => value === digits[0])
            ? digits[0]
            : undefined
        : digits.find((value) => digits.filter((other) => other === value).length >= 2 && parsed.includes(value));
    if (quantity === undefined) return chosen;
    return chosen.map((text) =>
        parseLootQuantity(text) === null ? text.replace(/^(.*?)\s+x\s*[^x]*$/i, `$1 x ${quantity}`) : text,
    );
}

export type LiveLootOcrWorkerOptions = {
    workerPath: string;
    corePath: string;
    langPath: string;
    cacheMethod: "none";
    gzip: true;
    workerBlobURL: false;
};

export type LiveLootOcrWorker = {
    setParameters(parameters: { tessedit_pageseg_mode: PSM; tessedit_char_whitelist?: string }): PromiseLike<unknown>;
    recognize(image: unknown): PromiseLike<{ data: { text: string } }>;
    terminate(): PromiseLike<unknown> | unknown;
};

export type LiveLootOcrWorkerFactory = (
    languages: "eng",
    oem: OEM.LSTM_ONLY,
    options: LiveLootOcrWorkerOptions,
) => PromiseLike<LiveLootOcrWorker>;

export type LiveLootOcrImageData = {
    data: Uint8ClampedArray;
};

export type LiveLootOcrCanvasContext = {
    createImageData(width: number, height: number): LiveLootOcrImageData;
    putImageData(image: LiveLootOcrImageData, x: number, y: number): void;
    clearRect(x: number, y: number, width: number, height: number): void;
};

export type LiveLootOcrCanvas = {
    width: number;
    height: number;
    getContext(contextId: "2d"): LiveLootOcrCanvasContext | null;
};

export type LiveLootOcrCanvasFactory = () => LiveLootOcrCanvas;

export type LiveLootTesseractOcr = {
    readText: LiveLootOcrReader;
    terminate(): Promise<void>;
};

export type LiveLootTesseractOcrOptions = {
    font?: LootFont;
    workerFactory?: LiveLootOcrWorkerFactory;
    canvasFactory?: LiveLootOcrCanvasFactory;
};

const defaultWorkerFactory: LiveLootOcrWorkerFactory = async (languages, oem, options) => {
    const worker = await createWorker(languages, oem, options);
    return {
        setParameters: (parameters) => worker.setParameters(parameters),
        recognize: (image) => worker.recognize(image as HTMLCanvasElement),
        terminate: () => worker.terminate(),
    };
};

const defaultCanvasFactory: LiveLootOcrCanvasFactory = () =>
    document.createElement("canvas") as unknown as LiveLootOcrCanvas;

function abortError() {
    if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
}

export function serializeLiveLootOcrReader(readText: LiveLootOcrReader): LiveLootOcrReader {
    let queue: Promise<void> = Promise.resolve();
    return (frames, signal) => {
        if (signal.aborted) return Promise.reject(abortError());
        const queuedReading = queue.then(() => {
            if (signal.aborted) throw abortError();
            return readText(frames, signal);
        });
        queue = queuedReading.then(
            () => undefined,
            () => undefined,
        );
        let onAbort: (() => void) | undefined;
        const cancellation = new Promise<never>((_, reject) => {
            onAbort = () => reject(abortError());
            signal.addEventListener("abort", onAbort, { once: true });
        });
        return Promise.race([queuedReading, cancellation]).finally(() => {
            if (onAbort) signal.removeEventListener("abort", onAbort);
        });
    };
}

function closedError() {
    return new Error("The live loot OCR reader is terminated.");
}

export async function createLiveLootTesseractOcr({
    font = "korean",
    workerFactory = defaultWorkerFactory,
    canvasFactory = defaultCanvasFactory,
}: LiveLootTesseractOcrOptions = {}): Promise<LiveLootTesseractOcr> {
    const ocrRoot = new URL("ocr/", document.baseURI);
    const worker = await workerFactory("eng", OEM.LSTM_ONLY, {
        workerPath: new URL("worker.min.js", ocrRoot).href,
        corePath: ocrRoot.href,
        langPath: ocrRoot.href,
        cacheMethod: "none",
        gzip: true,
        workerBlobURL: false,
    });

    try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    } catch (error) {
        try {
            await worker.terminate();
        } catch {
            // Preserve the setup failure rather than replacing it with a cleanup failure.
        }
        throw error;
    }

    let canvas: LiveLootOcrCanvas;
    let context: LiveLootOcrCanvasContext;
    try {
        canvas = canvasFactory();
        const createdContext = canvas.getContext("2d");
        if (!createdContext) throw new Error("A 2D canvas context is required for live loot OCR.");
        context = createdContext;
    } catch (error) {
        try {
            await worker.terminate();
        } catch {
            // Preserve the canvas setup failure rather than replacing it with a cleanup failure.
        }
        throw error;
    }

    let quantityMode: boolean | undefined = false;
    let busy = false;
    let closed = false;
    let terminationPromise: Promise<void> | undefined;
    let rejectActive: ((reason: unknown) => void) | undefined;
    let activeFrames: { frames: readonly LiveLootOcrFrame[] | undefined } | undefined;

    function clearCanvas() {
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
    }

    function close(reason: unknown) {
        if (closed && terminationPromise) return terminationPromise;
        closed = true;
        if (activeFrames) activeFrames.frames = undefined;
        clearCanvas();
        rejectActive?.(reason);
        if (!terminationPromise) {
            try {
                terminationPromise = Promise.resolve(worker.terminate()).then(() => undefined);
            } catch (error) {
                terminationPromise = Promise.reject(error);
            }
            void terminationPromise.catch(() => undefined);
        }
        return terminationPromise;
    }

    async function recognizeFrames(job: { frames: readonly LiveLootOcrFrame[] | undefined }) {
        const readings: string[][] = [];
        const frameCount = job.frames?.length ?? 0;
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            const frameReadings = await readLootOcrFrame(
                job.frames?.[frameIndex]?.textColor,
                async (threshold, scale, region) => {
                    if (closed) throw closedError();
                    if (quantityMode !== (region === "quantity")) {
                        const useQuantity = region === "quantity";
                        quantityMode = undefined;
                        await worker.setParameters({
                            tessedit_pageseg_mode: useQuantity ? PSM.SINGLE_WORD : PSM.SINGLE_LINE,
                            tessedit_char_whitelist: useQuantity ? "0123456789" : "",
                        });
                        quantityMode = useQuantity;
                        if (closed) throw closedError();
                    }
                    let source = job.frames?.[frameIndex];
                    if (!source) throw closedError();
                    const diagnostics = source.diagnostics;
                    const centerY = source.observation.centerY;
                    let processed: LootRoiFrame | undefined = preprocessLootOcrFrame(
                        source.roi,
                        centerY,
                        threshold,
                        region === "quantity" ? source.observation.fingerprint.digits?.bounds : source.bounds,
                        source.textColor,
                        scale,
                    );
                    source = undefined;

                    if (canvas.width !== processed.width) canvas.width = processed.width;
                    if (canvas.height !== processed.height) canvas.height = processed.height;
                    let imageData: LiveLootOcrImageData | undefined = context.createImageData(
                        processed.width,
                        processed.height,
                    );
                    imageData.data.set(processed.pixels);
                    context.putImageData(imageData, 0, 0);
                    processed = undefined;
                    imageData = undefined;

                    const result = await worker.recognize(canvas);
                    if (closed) throw closedError();
                    const text = result.data.text.trim();
                    diagnostics?.passes.push({ threshold, scale, region, text: text.slice(0, 512) });
                    return text;
                },
                job.frames?.[frameIndex]?.textColor !== "gold" &&
                    !!job.frames?.[frameIndex]?.observation.fingerprint.digits,
                font,
            );
            readings.push(frameReadings);
        }
        return readings;
    }

    const readText: LiveLootOcrReader = (frames, signal) => {
        if (signal.aborted) return Promise.reject(abortError());
        if (closed) return Promise.reject(closedError());
        if (busy) return Promise.reject(new Error("A live loot OCR read is already in progress."));
        busy = true;
        const job = { frames: frames as readonly LiveLootOcrFrame[] | undefined };
        activeFrames = job;

        const interrupt = new Promise<never>((_, reject) => {
            rejectActive = reject;
        });
        const onAbort = () => {
            close(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });

        return Promise.race([recognizeFrames(job), interrupt]).finally(() => {
            signal.removeEventListener("abort", onAbort);
            job.frames = undefined;
            if (activeFrames === job) activeFrames = undefined;
            rejectActive = undefined;
            busy = false;
            clearCanvas();
        });
    };

    return { readText, terminate: () => close(closedError()) };
}
