export const DISPLAY_CAPTURE_OPTIONS: DisplayMediaStreamOptions = {
    audio: false,
    video: true,
};

export class DisplayCaptureTimeoutError extends Error {
    constructor() {
        super("The system did not finish starting screen capture. Cancel and try selecting the monitor again.");
        this.name = "DisplayCaptureTimeoutError";
    }
}

export async function waitForDisplayCapture(request: Promise<MediaStream>, timeoutMs = 30_000): Promise<MediaStream> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            request,
            new Promise<never>((_, reject) => {
                timer = globalThis.setTimeout(() => reject(new DisplayCaptureTimeoutError()), timeoutMs);
            }),
        ]);
    } finally {
        globalThis.clearTimeout(timer);
    }
}

export function stopDisplayCapture(stream: MediaStream | null): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
}

export function displayCaptureErrorMessage(error: unknown): string {
    if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") return "Screen sharing was cancelled or denied by the system.";
        if (error.name === "NotFoundError") return "No monitor is available to share.";
        if (error.name === "NotReadableError") return "The selected monitor could not be read.";
        if (error.name === "AbortError") return "Screen sharing stopped before capture began.";
    }
    return error instanceof Error ? error.message : String(error);
}
