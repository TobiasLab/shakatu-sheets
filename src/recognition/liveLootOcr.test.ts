import { OEM, PSM } from "tesseract.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveLootOcrFrame, LootRoiFrame } from "./liveLoot";
import {
    createLiveLootTesseractOcr,
    type LiveLootOcrCanvas,
    type LiveLootOcrCanvasContext,
    type LiveLootOcrWorker,
    preprocessLootOcrFrame,
    readLootOcrFrame,
    serializeLiveLootOcrReader,
} from "./liveLootOcr";

function sourceFrame(width = 8, height = 24, fill = 0): LootRoiFrame {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = fill;
        pixels[offset + 1] = fill;
        pixels[offset + 2] = fill;
        pixels[offset + 3] = 255;
    }
    return { width, height, pixels };
}

function setPixel(frame: LootRoiFrame, x: number, y: number, red: number, green = red, blue = red, alpha = 255) {
    const offset = (y * frame.width + x) * 4;
    frame.pixels.set([red, green, blue, alpha], offset);
}

function outputPixel(frame: LootRoiFrame, x: number, y: number) {
    const offset = (y * frame.width + x) * 4;
    return [...frame.pixels.slice(offset, offset + 4)];
}

function blackPixelCount(frame: LootRoiFrame) {
    let count = 0;
    for (let offset = 0; offset < frame.pixels.length; offset += 4) {
        if (frame.pixels[offset] === 0) count += 1;
    }
    return count;
}

function ocrFrame(frame = 0, roi = sourceFrame(), centerY = 12): LiveLootOcrFrame {
    return {
        frame,
        roi,
        observation: {
            slot: 0,
            centerY,
            score: 1,
            fingerprint: { full: new Uint8Array(), quantity: new Uint8Array() },
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function testCanvas() {
    const images: Uint8ClampedArray[] = [];
    const clears: Array<[number, number, number, number]> = [];
    const context: LiveLootOcrCanvasContext = {
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: (image) => images.push(image.data.slice()),
        clearRect: (...args) => clears.push(args),
    };
    const canvas: LiveLootOcrCanvas = {
        width: 0,
        height: 0,
        getContext: () => context,
    };
    return { canvas, context, images, clears };
}

function textResult(text: string) {
    return { data: { text } };
}

function mockWorker(recognize: LiveLootOcrWorker["recognize"] = async () => textResult("text x 1")) {
    return {
        setParameters: vi.fn<LiveLootOcrWorker["setParameters"]>(async () => undefined),
        recognize: vi.fn<LiveLootOcrWorker["recognize"]>(recognize),
        terminate: vi.fn<LiveLootOcrWorker["terminate"]>(async () => undefined),
    } satisfies LiveLootOcrWorker;
}

function installDocument() {
    vi.stubGlobal("document", { baseURI: "https://example.test/application/index.html" });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("preprocessLootOcrFrame", () => {
    it("returns the exact scaled crop dimensions with opaque white padding", () => {
        const output = preprocessLootOcrFrame(sourceFrame(20, 30), 15, 130);

        expect(output.width).toBe((Math.round(20 * 0.8) - Math.round(20 * 0.25)) * 2 + 20);
        expect(output.height).toBe(24 * 2 + 20);
        expect(output.pixels).toHaveLength(output.width * output.height * 4);
        expect(outputPixel(output, 0, 0)).toEqual([255, 255, 255, 255]);
        expect(outputPixel(output, 9, 10)).toEqual([255, 255, 255, 255]);
        expect(outputPixel(output, output.width - 1, output.height - 1)).toEqual([255, 255, 255, 255]);
        for (let offset = 3; offset < output.pixels.length; offset += 4) expect(output.pixels[offset]).toBe(255);
    });

    it("expands one accepted source pixel to exactly one 2x2 black block", () => {
        const frame = sourceFrame(8, 24);
        setPixel(frame, 2, 0, 130);

        const output = preprocessLootOcrFrame(frame, 12, 130);

        expect(blackPixelCount(output)).toBe(4);
        for (let y = 10; y < 12; y += 1) {
            for (let x = 10; x < 12; x += 1) expect(outputPixel(output, x, y)).toEqual([0, 0, 0, 255]);
        }
        expect(outputPixel(output, 12, 10)).toEqual([255, 255, 255, 255]);
    });

    it("uses inclusive integer luminance boundaries", () => {
        const frame = sourceFrame();
        setPixel(frame, 2, 0, 149);
        setPixel(frame, 3, 0, 150);

        const output = preprocessLootOcrFrame(frame, 12, 150);

        expect(outputPixel(output, 10, 10)).toEqual([255, 255, 255, 255]);
        expect(outputPixel(output, 12, 10)).toEqual([0, 0, 0, 255]);
    });

    it("uses explicit source bounds for non-stack notifications", () => {
        const frame = sourceFrame(20, 30);
        setPixel(frame, 18, 28, 130);

        expect(blackPixelCount(preprocessLootOcrFrame(frame, 15, 130))).toBe(0);
        const output = preprocessLootOcrFrame(frame, 15, 130, { left: 1, right: 19, top: 2, bottom: 29 });

        expect(output.width).toBe(18 * 2 + 20);
        expect(output.height).toBe(27 * 2 + 20);
        expect(blackPixelCount(output)).toBe(4);
        expect(outputPixel(output, 10 + 17 * 2, 10 + 26 * 2)).toEqual([0, 0, 0, 255]);
    });

    it("accepts chroma 65 and rejects chroma 66", () => {
        const frame = sourceFrame();
        setPixel(frame, 2, 0, 200, 135, 200);
        setPixel(frame, 3, 0, 201, 135, 200);

        const output = preprocessLootOcrFrame(frame, 12, 130);

        expect(outputPixel(output, 10, 10)).toEqual([0, 0, 0, 255]);
        expect(outputPixel(output, 12, 10)).toEqual([255, 255, 255, 255]);
    });

    it("retains gold lettering only for an explicitly gold OCR job", () => {
        const frame = sourceFrame();
        setPixel(frame, 2, 0, 230, 200, 110);
        expect(blackPixelCount(preprocessLootOcrFrame(frame, 12, 170))).toBe(0);
        const gold = preprocessLootOcrFrame(frame, 12, 170, undefined, "gold");
        expect(gold.width).toBe(4 * 4 + 20);
        expect(gold.height).toBe(24 * 4 + 20);
        expect(blackPixelCount(gold)).toBe(16);
    });

    it("is monotonically more selective across the supported thresholds", () => {
        const frame = sourceFrame();
        setPixel(frame, 2, 0, 130);
        setPixel(frame, 3, 0, 150);
        setPixel(frame, 4, 0, 170);

        expect(
            ([130, 150, 170] as const).map((threshold) =>
                blackPixelCount(preprocessLootOcrFrame(frame, 12, threshold)),
            ),
        ).toEqual([12, 8, 4]);
    });

    it("keeps out-of-bounds crop samples white", () => {
        const frame = sourceFrame(8, 4, 255);
        const output = preprocessLootOcrFrame(frame, 0, 130);

        expect(outputPixel(output, 10, 10)).toEqual([255, 255, 255, 255]);
        expect(outputPixel(output, 10, 33)).toEqual([255, 255, 255, 255]);
        expect(outputPixel(output, 10, 34)).toEqual([0, 0, 0, 255]);
        expect(outputPixel(output, 10, 41)).toEqual([0, 0, 0, 255]);
        expect(outputPixel(output, 10, 42)).toEqual([255, 255, 255, 255]);
    });

    it("validates dimensions, buffers, centers, and thresholds without mutating the source", () => {
        const frame = sourceFrame();
        setPixel(frame, 2, 0, 150, 150, 150, 17);
        const before = frame.pixels.slice();

        preprocessLootOcrFrame(frame, 12, 150);

        expect(frame.pixels).toEqual(before);
        expect(() => preprocessLootOcrFrame({ ...frame, width: 0 }, 12, 150)).toThrow("dimensions");
        expect(() => preprocessLootOcrFrame(frame, 2 ** 54, 150)).toThrow("safe integer");
        expect(() => preprocessLootOcrFrame(sourceFrame(100_000, 1), 0, 150)).toThrow("too large");
        expect(() => preprocessLootOcrFrame({ ...frame, width: 7 }, 12, 150)).toThrow("tightly packed");
        expect(() => preprocessLootOcrFrame({ ...frame, pixels: new Uint8ClampedArray(3) }, 12, 150)).toThrow(
            "tightly packed",
        );
        expect(() => preprocessLootOcrFrame(frame, 12.5, 150)).toThrow("integer");
        expect(() => preprocessLootOcrFrame(frame, 12, 140 as 130)).toThrow("130, 150, or 170");
        expect(() => preprocessLootOcrFrame(frame, 12, 150, undefined, "white", 3 as 2)).toThrow("enlargement");
        expect(() => preprocessLootOcrFrame(frame, 12, 150, { left: 4, right: 4, top: 0, bottom: 24 })).toThrow(
            "OCR bounds",
        );
        expect(() => preprocessLootOcrFrame(frame, 12, 150, { left: 0, right: 8, top: 0, bottom: 25 })).toThrow(
            "OCR bounds",
        );
    });
});

describe("readLootOcrFrame", () => {
    it("keeps the smaller pass when two thresholds agree without hiding a conflicting third reading", async () => {
        const texts = ["Branch of Abundance x 10", "Branch of Abundance x 10", "Branch of Abundance x 110"];
        let index = 0;
        const recognize = vi.fn<(threshold: number, scale: number) => Promise<string>>(async () => texts[index++]);
        expect(await readLootOcrFrame(undefined, recognize)).toEqual(texts);
        expect(recognize.mock.calls).toEqual([
            [130, 2, "line"],
            [150, 2, "line"],
            [170, 2, "line"],
        ]);
    });

    it("retries an uncertain quantity once at the original size", async () => {
        const texts = [
            "Branch of Abundance x5;",
            "Branch of Abundance x §",
            "Branch of Abundance x",
            "Branch of Abundance x6;",
            "Branch of Abundance x 6",
            "Branch of Abundance x 6",
        ];
        let index = 0;
        const recognize = vi.fn<(threshold: number, scale: number) => Promise<string>>(async () => texts[index++]);
        expect(await readLootOcrFrame("white", recognize)).toEqual(texts.slice(3));
        expect(recognize.mock.calls).toEqual([
            [130, 2, "line"],
            [150, 2, "line"],
            [170, 2, "line"],
            [130, 4, "line"],
            [150, 4, "line"],
            [170, 4, "line"],
        ]);
    });

    it("retains the primary readings when the retry cannot parse a quantity", async () => {
        const primary = ["noise", "Branch of Abundance x &", "Branch of Abundance x 6"];
        let index = 0;
        const recognize = vi.fn<(threshold: number, scale: number) => Promise<string>>(
            async () => primary[index++] ?? "noise",
        );
        expect(await readLootOcrFrame("white", recognize)).toEqual(primary);
        expect(recognize).toHaveBeenCalledTimes(6);
    });

    it("bounds an entirely unreadable normal frame to six passes", async () => {
        const recognize = vi.fn(async () => "noise");
        expect(await readLootOcrFrame("white", recognize, true)).toEqual(["noise", "noise", "noise"]);
        expect(recognize).toHaveBeenCalledTimes(6);
    });

    it("keeps gold text at the original size without retrying", async () => {
        const recognize = vi.fn(async () => "noise");
        expect(await readLootOcrFrame("gold", recognize)).toEqual(["noise", "noise", "noise"]);
        expect(recognize.mock.calls).toEqual([
            [130, 4, "line"],
            [150, 4, "line"],
            [170, 4, "line"],
        ]);
    });
});

describe("serializeLiveLootOcrReader", () => {
    it("runs shared-worker reads sequentially", async () => {
        const first = deferred<readonly (readonly string[])[]>();
        const readText = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce([["second"]]);
        const serialized = serializeLiveLootOcrReader(readText);
        const firstRead = serialized([ocrFrame()], new AbortController().signal);
        const secondRead = serialized([ocrFrame(1)], new AbortController().signal);

        await Promise.resolve();
        expect(readText).toHaveBeenCalledOnce();
        first.resolve([["first"]]);
        await expect(firstRead).resolves.toEqual([["first"]]);
        await expect(secondRead).resolves.toEqual([["second"]]);
        expect(readText).toHaveBeenCalledTimes(2);
    });

    it("does not start a queued read that was cancelled", async () => {
        const first = deferred<readonly (readonly string[])[]>();
        const readText = vi.fn(() => first.promise);
        const serialized = serializeLiveLootOcrReader(readText);
        const firstRead = serialized([ocrFrame()], new AbortController().signal);
        const queuedController = new AbortController();
        const queuedRead = serialized([ocrFrame(1)], queuedController.signal);
        queuedController.abort();

        await expect(queuedRead).rejects.toMatchObject({ name: "AbortError" });
        expect(readText).toHaveBeenCalledOnce();
        first.resolve([["first"]]);
        await firstRead;
    });
});

describe("createLiveLootTesseractOcr", () => {
    it("creates and configures one worker with document-relative local assets", async () => {
        installDocument();
        const worker = mockWorker();
        const canvas = testCanvas();
        const factory = vi.fn(async () => worker);

        const reader = await createLiveLootTesseractOcr({ workerFactory: factory, canvasFactory: () => canvas.canvas });
        await reader.readText([ocrFrame()], new AbortController().signal);

        expect(factory).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledWith("eng", OEM.LSTM_ONLY, {
            workerPath: "https://example.test/application/ocr/worker.min.js",
            corePath: "https://example.test/application/ocr/",
            langPath: "https://example.test/application/ocr/",
            cacheMethod: "none",
            gzip: true,
            workerBlobURL: false,
        });
        expect(worker.setParameters).toHaveBeenCalledOnce();
        expect(worker.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
        expect(factory.mock.invocationCallOrder[0]).toBeLessThan(worker.setParameters.mock.invocationCallOrder[0]);
        expect(worker.setParameters.mock.invocationCallOrder[0]).toBeLessThan(
            worker.recognize.mock.invocationCallOrder[0],
        );
    });

    it("processes frames before thresholds, trims text, and reuses one canvas", async () => {
        installDocument();
        const canvas = testCanvas();
        const returned = [
            " first-130 x 1 \n",
            "first-150 x 1",
            " first-170 x 1",
            "second-130 x 1 ",
            " second-150 x 1",
            "second-170 x 1\n",
        ];
        let index = 0;
        const worker = mockWorker(async () => textResult(returned[index++]));
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });

        const result = await reader.readText([ocrFrame(1), ocrFrame(2)], new AbortController().signal);

        expect(result).toEqual([
            ["first-130 x 1", "first-150 x 1", "first-170 x 1"],
            ["second-130 x 1", "second-150 x 1", "second-170 x 1"],
        ]);
        expect(worker.recognize).toHaveBeenCalledTimes(6);
        expect(worker.recognize.mock.calls.every(([recognizedCanvas]) => recognizedCanvas === canvas.canvas)).toBe(
            true,
        );
        expect(canvas.images).toHaveLength(6);
        expect(canvas.clears).toHaveLength(1);
        expect(canvas.canvas).toMatchObject({ width: 0, height: 0 });
    });

    it("renders the full-size retry with the same crop and white-text filtering", async () => {
        installDocument();
        const canvas = testCanvas();
        const roi = sourceFrame(20, 30);
        setPixel(roi, 2, 3, 230);
        setPixel(roi, 4, 3, 230, 200, 110);
        const before = roi.pixels.slice();
        let calls = 0;
        const worker = mockWorker(async () =>
            textResult(++calls <= 3 ? "Branch of Abundance x §" : "Branch of Abundance x 6"),
        );
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });
        const frame = {
            ...ocrFrame(0, roi, 15),
            bounds: { left: 1, right: 19, top: 2, bottom: 29 },
        };

        expect(await reader.readText([frame], new AbortController().signal)).toEqual([
            Array.from({ length: 3 }, () => "Branch of Abundance x 6"),
        ]);
        expect(canvas.images).toHaveLength(6);
        for (const [index, pixels] of canvas.images.entries()) {
            const scale = index < 3 ? 2 : 4;
            const width = 18 * scale + 20;
            const height = 27 * scale + 20;
            expect(pixels).toHaveLength(width * height * 4);
            expect(blackPixelCount({ width, height, pixels })).toBe(scale * scale);
        }
        expect(roi.pixels).toEqual(before);
        expect(canvas.canvas).toMatchObject({ width: 0, height: 0 });
        await reader.terminate();
    });

    it("cancels during the full-size retry without starting another pass", async () => {
        installDocument();
        const canvas = testCanvas();
        const retry = deferred<ReturnType<typeof textResult>>();
        let calls = 0;
        const worker = mockWorker(async () => {
            calls += 1;
            return calls === 4 ? retry.promise : textResult("Branch of Abundance x §");
        });
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });
        const controller = new AbortController();
        const pending = reader.readText([ocrFrame()], controller.signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledTimes(4));
        controller.abort();
        await rejected;
        retry.resolve(textResult("Branch of Abundance x 6"));
        await Promise.resolve();
        expect(worker.recognize).toHaveBeenCalledTimes(4);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(canvas.canvas).toMatchObject({ width: 0, height: 0 });
    });

    it("applies each coordinator's OCR bounds", async () => {
        installDocument();
        const canvas = testCanvas();
        const worker = mockWorker();
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });
        const frame = {
            ...ocrFrame(0, sourceFrame(20, 30), 15),
            bounds: { left: 1, right: 19, top: 2, bottom: 29 },
        };

        await reader.readText([frame], new AbortController().signal);

        expect(canvas.images).toHaveLength(3);
        expect(canvas.images.every((image) => image.length === (18 * 2 + 20) * (27 * 2 + 20) * 4)).toBe(true);
    });

    it("rejects concurrent reads without another recognize call", async () => {
        installDocument();
        const firstRecognition = deferred<{ data: { text: string } }>();
        const worker = mockWorker(() => firstRecognition.promise);
        const canvas = testCanvas();
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });
        const signal = new AbortController().signal;

        const firstRead = reader.readText([ocrFrame()], signal);
        await expect(reader.readText([ocrFrame(1)], signal)).rejects.toThrow("already in progress");
        expect(worker.recognize).toHaveBeenCalledOnce();

        firstRecognition.resolve(textResult("one"));
        await firstRead;
    });

    it("propagates ordinary recognize failures, clears, and permits recovery", async () => {
        installDocument();
        const failure = new Error("recognize failed");
        let calls = 0;
        const worker = mockWorker(async () => {
            calls += 1;
            if (calls === 1) throw failure;
            return textResult(" recovered ");
        });
        const canvas = testCanvas();
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });

        await expect(reader.readText([ocrFrame()], new AbortController().signal)).rejects.toBe(failure);
        await expect(reader.readText([ocrFrame()], new AbortController().signal)).resolves.toEqual([
            ["recovered", "recovered", "recovered"],
        ]);
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(canvas.clears).toHaveLength(2);
    });

    it("rejects a pre-aborted read without recognizing and remains usable", async () => {
        installDocument();
        const worker = mockWorker();
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => testCanvas().canvas,
        });
        const controller = new AbortController();
        controller.abort();

        await expect(reader.readText([ocrFrame()], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(worker.recognize).not.toHaveBeenCalled();
        await expect(reader.readText([ocrFrame()], new AbortController().signal)).resolves.toHaveLength(1);
    });

    it.each(["resolve", "reject"] as const)(
        "actively aborts promptly and safely handles a late worker %s",
        async (settlement) => {
            installDocument();
            const recognition = deferred<{ data: { text: string } }>();
            const worker = mockWorker(() => recognition.promise);
            const canvas = testCanvas();
            const reader = await createLiveLootTesseractOcr({
                workerFactory: async () => worker,
                canvasFactory: () => canvas.canvas,
            });
            const controller = new AbortController();
            const reading = reader.readText([ocrFrame(), ocrFrame(1)], controller.signal);

            controller.abort();

            await expect(reading).rejects.toMatchObject({ name: "AbortError" });
            expect(worker.terminate).toHaveBeenCalledOnce();
            expect(worker.recognize).toHaveBeenCalledOnce();
            expect(canvas.clears.length).toBeGreaterThan(0);
            await expect(reader.readText([ocrFrame()], new AbortController().signal)).rejects.toThrow("terminated");
            if (settlement === "resolve") recognition.resolve(textResult("late"));
            else recognition.reject(new Error("late failure"));
            await Promise.resolve();
            await Promise.resolve();
            expect(worker.recognize).toHaveBeenCalledOnce();
        },
    );

    it("terminates idempotently, closes synchronously, and clears the canvas", async () => {
        installDocument();
        const termination = deferred<void>();
        const worker = mockWorker();
        worker.terminate.mockImplementation(() => termination.promise);
        const canvas = testCanvas();
        const reader = await createLiveLootTesseractOcr({
            workerFactory: async () => worker,
            canvasFactory: () => canvas.canvas,
        });

        const firstTermination = reader.terminate();
        const secondTermination = reader.terminate();

        expect(secondTermination).toBe(firstTermination);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(canvas.clears).toHaveLength(1);
        expect(canvas.canvas).toMatchObject({ width: 0, height: 0 });
        await expect(reader.readText([], new AbortController().signal)).rejects.toThrow("terminated");
        termination.resolve();
        await firstTermination;
    });

    it("terminates an acquired worker when parameter setup fails", async () => {
        installDocument();
        const setupFailure = new Error("parameter setup failed");
        const worker = mockWorker();
        worker.setParameters.mockRejectedValue(setupFailure);

        await expect(
            createLiveLootTesseractOcr({ workerFactory: async () => worker, canvasFactory: () => testCanvas().canvas }),
        ).rejects.toBe(setupFailure);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.recognize).not.toHaveBeenCalled();
    });

    it("propagates worker factory failures without attempting setup", async () => {
        installDocument();
        const factoryFailure = new Error("worker factory failed");
        const factory = vi.fn(async (): Promise<LiveLootOcrWorker> => {
            throw factoryFailure;
        });

        await expect(
            createLiveLootTesseractOcr({ workerFactory: factory, canvasFactory: () => testCanvas().canvas }),
        ).rejects.toBe(factoryFailure);
        expect(factory).toHaveBeenCalledOnce();
    });

    it("terminates the worker when canvas setup fails", async () => {
        installDocument();
        const worker = mockWorker();

        await expect(
            createLiveLootTesseractOcr({
                workerFactory: async () => worker,
                canvasFactory: () => ({ width: 0, height: 0, getContext: () => null }),
            }),
        ).rejects.toThrow("2D canvas");
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
});

it("uses a separate quantity only to corroborate an existing weak reading", async () => {
    const line = ["Branch of Abundance x &", "Branch of Abundance x 6", "Branch of Abundance x ?"];
    let index = 0;
    const calls: string[] = [];
    const result = await readLootOcrFrame(
        "white",
        async (_threshold, _scale, region) => {
            calls.push(region);
            return region === "quantity" ? "6" : line[index++ % 3];
        },
        true,
    );
    expect(result).toEqual(Array(3).fill("Branch of Abundance x 6"));
    expect(calls).toEqual([...Array(6).fill("line"), ...Array(3).fill("quantity")]);
});

it("does not invent quantities or replace conflicting full-line readings", async () => {
    for (const line of [
        ["Item x ?", "Item x ?", "Item x ?"],
        ["Item x 4", "Item x 6", "Item x ?"],
    ]) {
        let index = 0;
        const result = await readLootOcrFrame(
            "white",
            async (_threshold, _scale, region) => (region === "quantity" ? "3" : line[index++ % 3]),
            true,
        );
        expect(result).toEqual(line);
    }
    let index = 0;
    expect(
        await readLootOcrFrame(
            "white",
            async (_threshold, _scale, region) =>
                region === "quantity" ? "6" : ["Item x 4", "Item x 6", "Item x ?"][index++ % 3],
            true,
        ),
    ).toEqual(["Item x 4", "Item x 6", "Item x 6"]);
});

it("restores full-line OCR parameters after a quantity retry before reading rare loot", async () => {
    installDocument();
    let pass = 0;
    const worker = mockWorker(async () => {
        const index = pass++;
        return textResult(
            index < 6 ? ["Item x ?", "Item x 6", "Item x ?"][index % 3] : index < 9 ? "6" : "Rare Item x 1",
        );
    });
    const canvas = testCanvas();
    const reader = await createLiveLootTesseractOcr({
        workerFactory: async () => worker,
        canvasFactory: () => canvas.canvas,
    });
    const normal = ocrFrame();
    normal.observation.fingerprint.digits = {
        bounds: { left: 2, right: 5, top: 4, bottom: 20 },
        pixels: new Uint8Array(48),
    };
    normal.diagnostics = { passes: [] };
    const rare = { ...ocrFrame(1), textColor: "gold" as const };
    expect(await reader.readText([normal, rare], new AbortController().signal)).toEqual([
        ["Item x 6", "Item x 6", "Item x 6"],
        ["Rare Item x 1", "Rare Item x 1", "Rare Item x 1"],
    ]);
    expect(worker.setParameters.mock.calls).toEqual([
        [{ tessedit_pageseg_mode: PSM.SINGLE_LINE }],
        [{ tessedit_pageseg_mode: PSM.SINGLE_WORD, tessedit_char_whitelist: "0123456789" }],
        [{ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: "" }],
    ]);
    expect(normal.diagnostics.passes).toHaveLength(9);
    expect(normal.diagnostics.passes[6]).toEqual({ threshold: 130, scale: 4, region: "quantity", text: "6" });
    await reader.terminate();
});

it("preserves Strong Sword antialiasing without changing Korean or gold preprocessing", () => {
    const frame = sourceFrame(20, 30);
    setPixel(frame, 7, 14, 160);
    setPixel(frame, 8, 14, 235);
    const original = frame.pixels.slice();
    const korean = preprocessLootOcrFrame(frame, 15, 150);
    const strong = preprocessLootOcrFrame(frame, 15, 150, undefined, "white", 4, "strong-sword");
    expect(strong.pixels.some((value, index) => index % 4 !== 3 && value > 0 && value < 255)).toBe(true);
    expect(preprocessLootOcrFrame(frame, 15, 150, undefined, "white", 2, "korean")).toEqual(korean);
    expect(preprocessLootOcrFrame(frame, 15, 150, undefined, "gold", 4, "strong-sword")).toEqual(
        preprocessLootOcrFrame(frame, 15, 150, undefined, "gold", 4),
    );
    expect(frame.pixels).toEqual(original);
});

it("keeps Strong Sword quantity corroboration conservative and bounds OCR work", async () => {
    const recognize = vi.fn(async (threshold: number, scale: number, region: string) => {
        expect(scale).toBe(4);
        return region === "quantity" ? "6" : threshold === 150 ? "Branch of Abundance x 6" : "Branch of Abundance x &";
    });
    expect(await readLootOcrFrame("white", recognize, true, "strong-sword")).toEqual(
        Array(3).fill("Branch of Abundance x 6"),
    );
    expect(recognize).toHaveBeenCalledTimes(6);
    const unreadable = vi.fn(async () => "Branch of Abundance x &");
    expect(await readLootOcrFrame("white", unreadable, true, "strong-sword")).toEqual(
        Array(3).fill("Branch of Abundance x &"),
    );
    expect(unreadable).toHaveBeenCalledTimes(3);
});
