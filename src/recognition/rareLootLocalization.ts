import { pixelRegionToNormalized } from "./displayCapture";
import { type LootSearchFrame, validateSearchFrame } from "./liveLootLocalization";
import { RARE_LOOT_GEOMETRY } from "./rareLoot";

type Candidate = { x: number; y: number; score: number };

// Integral sums keep the bounded search linear in its pixel count instead of rescanning each candidate's shell.
function locateBanner(frame: LootSearchFrame): Candidate | null {
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
            if (gold && y >= 3 && light(offset) - light(offset - frame.width * 12) >= 25) edgeRow += 1;
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
    const { shell, border, width, height, borderMinPixels } = RARE_LOOT_GEOMETRY;
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
                (sum(warm, x + shell.left - 8, y + shell.top, 8, shellHeight) +
                    sum(warm, x + shell.right, y + shell.top, 8, shellHeight) +
                    sum(warm, x + shell.left, y + shell.top - 8, shellWidth, 8) +
                    sum(warm, x + shell.left, y + shell.bottom, shellWidth, 8)) /
                (16 * (shellWidth + shellHeight));
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
    private previous: Candidate | null = null;
    private source = "";
    private observations = 0;

    pushFrame(frame: LootSearchFrame) {
        validateSearchFrame(frame);
        const source = `${frame.sourceWidth}x${frame.sourceHeight}`;
        if (source !== this.source) this.clear();
        this.source = source;
        const candidate = locateBanner(frame);
        if (!candidate) {
            this.previous = null;
            this.observations = 0;
            return null;
        }
        this.observations =
            this.previous && Math.hypot(candidate.x - this.previous.x, candidate.y - this.previous.y) <= 3
                ? this.observations + 1
                : 1;
        this.previous = candidate;
        if (this.observations < 3) return null;
        const region = pixelRegionToNormalized(
            {
                x: candidate.x,
                y: candidate.y,
                width: RARE_LOOT_GEOMETRY.width,
                height: RARE_LOOT_GEOMETRY.height,
            },
            frame.sourceWidth,
            frame.sourceHeight,
        );
        this.clear();
        return { region, replayFrames: [] };
    }

    clear() {
        this.previous = null;
        this.source = "";
        this.observations = 0;
    }
}
