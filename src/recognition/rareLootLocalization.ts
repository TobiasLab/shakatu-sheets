import { type LootUiScale, pixelRegionToNormalized } from "./displayCapture";
import { type LootSearchFrame, validateSearchFrame } from "./liveLootLocalization";
import type { LootSampleFps } from "./lootCaptureTiming";
import { RARE_LOOT_GEOMETRY, RARE_LOOT_GEOMETRY_100, type RareLootGeometry } from "./rareLoot";

type Candidate = { x: number; y: number; score: number };

// Integral sums keep the bounded search linear in its pixel count instead of rescanning each candidate's shell.
function locateBanner(frame: LootSearchFrame, geometry: RareLootGeometry): Candidate | null {
    const { borderOffset } = geometry;
    const margin = Math.round((8 * geometry.width) / 400);
    const stride = frame.width + 1;
    const warm = new Uint32Array(stride * (frame.height + 1));
    const edges = new Uint32Array(warm.length);
    const light = (offset: number) =>
        (frame.pixels[offset] * 77 + frame.pixels[offset + 1] * 150 + frame.pixels[offset + 2] * 29) >> 8;
    for (let y = 0; y < frame.height; y += 1) {
        let warmRow = 0;
        let edgeRow = 0;
        for (let x = 0; x < frame.width; x += 1) {
            const offset = (y * frame.width + x) * 4;
            const r = frame.pixels[offset];
            const g = frame.pixels[offset + 1];
            const b = frame.pixels[offset + 2];
            const gold = r >= 105 && g >= 65 && r - b >= 55 && g - b >= 20;
            if (gold) warmRow += 1;
            if (gold && y >= borderOffset && light(offset) - light(offset - frame.width * 4 * borderOffset) >= 25)
                edgeRow += 1;
            const index = (y + 1) * stride + x + 1;
            warm[index] = warm[index - stride] + warmRow;
            edges[index] = edges[index - stride] + edgeRow;
        }
    }
    const sum = (pixels: Uint32Array, x: number, y: number, width: number, height: number) =>
        pixels[(y + height) * stride + x + width] -
        pixels[y * stride + x + width] -
        pixels[(y + height) * stride + x] +
        pixels[y * stride + x];
    const { shell, border, width, height, borderMinPixels } = geometry;
    const shellWidth = shell.right - shell.left;
    const shellHeight = shell.bottom - shell.top;
    const candidates: Candidate[] = [];
    let best: Candidate | null = null;
    for (let y = 0; y <= frame.height - height; y += 1) {
        for (let x = 0; x <= frame.width - width; x += 1) {
            const fill = sum(warm, x + shell.left, y + shell.top, shellWidth, shellHeight) / (shellWidth * shellHeight);
            if (fill < 0.65) continue;
            let edge = 0;
            for (let row = border.top; row < border.bottom; row += 1) {
                edge = Math.max(edge, sum(edges, x + border.left, y + row, border.right - border.left, 1));
            }
            if (edge < borderMinPixels) continue;
            const surround =
                (sum(warm, x + shell.left - margin, y + shell.top, margin, shellHeight) +
                    sum(warm, x + shell.right, y + shell.top, margin, shellHeight) +
                    sum(warm, x + shell.left, y + shell.top - margin, shellWidth, margin) +
                    sum(warm, x + shell.left, y + shell.bottom, shellWidth, margin)) /
                (2 * margin * (shellWidth + shellHeight));
            const score = fill - surround;
            if (score < 0.3) continue;
            const candidate = { x, y, score };
            candidates.push(candidate);
            if (!best || score > best.score) best = candidate;
        }
    }
    if (
        !best ||
        candidates.some(
            (candidate) =>
                Math.hypot(candidate.x - best.x, candidate.y - best.y) > 12 && candidate.score >= best.score - 0.05,
        )
    )
        return null;
    return { ...best, x: best.x + frame.cropX, y: best.y + frame.cropY };
}

export class RareLootLocalizer {
    private readonly observations: Candidate[] = [];
    private source = "";
    private incomingFrameCount = 0;
    private readonly geometry: RareLootGeometry;

    constructor(
        uiScalePercent: LootUiScale = 80,
        private readonly sampleFps: LootSampleFps = 8,
    ) {
        this.geometry = uiScalePercent === 100 ? RARE_LOOT_GEOMETRY_100 : RARE_LOOT_GEOMETRY;
    }

    pushFrame(frame: LootSearchFrame) {
        validateSearchFrame(frame);
        const source = `${frame.sourceWidth}x${frame.sourceHeight}`;
        if (source !== this.source) this.clear();
        this.source = source;
        if (this.incomingFrameCount++ % (this.sampleFps / 8) !== 0) return null;
        const candidate = locateBanner(frame, this.geometry);
        if (!candidate) {
            this.observations.length = 0;
            return null;
        }
        if (this.observations.some((previous) => Math.hypot(candidate.x - previous.x, candidate.y - previous.y) > 3)) {
            this.observations.length = 0;
        }
        this.observations.push(candidate);
        if (this.observations.length < 3) return null;
        const region = pixelRegionToNormalized(
            {
                x: candidate.x,
                y: candidate.y,
                width: this.geometry.width,
                height: this.geometry.height,
            },
            frame.sourceWidth,
            frame.sourceHeight,
        );
        this.clear();
        return { region, replayFrames: [] };
    }

    clear() {
        this.incomingFrameCount = 0;
        this.observations.length = 0;
        this.source = "";
    }
}
