import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { benchmarkEvents, calibrateThreshold } from "./loot-benchmark-core.mjs";

export function createLootBenchmarkVision({ manifestPath, manifest }) {
    const benchmarkDirectory = dirname(manifestPath);
    const width = manifest.roi?.pixels?.width;
    const height = manifest.roi?.pixels?.height;
    const maxRows = manifest.maxRows;

    function decodeFrames(segment) {
        return new Promise((resolveDecode, rejectDecode) => {
            const child = spawn(
                "ffmpeg",
                [
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-framerate",
                    String(manifest.sampleFps),
                    "-i",
                    join(benchmarkDirectory, segment.directory, segment.framePattern),
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "pipe:1",
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
            );
            const stdout = [];
            const stderr = [];
            child.stdout.on("data", (chunk) => stdout.push(chunk));
            child.stderr.on("data", (chunk) => stderr.push(chunk));
            child.on("error", rejectDecode);
            child.on("close", (code) => {
                if (code !== 0) {
                    rejectDecode(
                        new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
                    );
                    return;
                }
                const bytes = Buffer.concat(stdout);
                const frameSize = width * height * 3;
                if (bytes.length !== frameSize * segment.frameCount) {
                    rejectDecode(new Error(`${segment.id}: expected ${segment.frameCount} decoded frames.`));
                    return;
                }
                resolveDecode(
                    Array.from({ length: segment.frameCount }, (_, index) =>
                        bytes.subarray(index * frameSize, (index + 1) * frameSize),
                    ),
                );
            });
        });
    }

    function luminance(frame, offset) {
        return (frame[offset] * 77 + frame[offset + 1] * 150 + frame[offset + 2] * 29) >> 8;
    }

    function isGlyphPixel(frame, offset) {
        const light = luminance(frame, offset);
        const chroma =
            Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
            Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
        const horizontal = Math.min(luminance(frame, offset - 6), luminance(frame, offset + 6));
        const vertical = Math.min(luminance(frame, offset - width * 6), luminance(frame, offset + width * 6));
        return light >= 115 && chroma <= 55 && light - Math.min(horizontal, vertical) >= 18;
    }

    function rowScore(frame, centerY) {
        let score = 0;
        const left = Math.round(width * 0.22);
        const right = Math.round(width * 0.96);
        for (let y = centerY - 6; y <= centerY + 6; y += 1) {
            for (let x = left; x < right; x += 1) {
                const offset = (y * width + x) * 3;
                if (isGlyphPixel(frame, offset)) score += 1;
            }
        }
        return score;
    }

    function extractScoreProfiles(frames) {
        return frames.map((frame) =>
            Array.from({ length: height }, (_, centerY) =>
                centerY >= 8 && centerY < height - 8 ? rowScore(frame, centerY) : 0,
            ),
        );
    }

    function extractFeatures(profiles, bottomCenter, spacing) {
        return profiles.map((profile) =>
            Array.from({ length: maxRows }, (_, index) => profile[bottomCenter - (maxRows - index - 1) * spacing]),
        );
    }

    function calibrateRowThreshold(trainingSets) {
        const examples = [];
        for (const { segment, features } of trainingSets) {
            for (let frame = 0; frame < features.length; frame += 1) {
                const count = benchmarkEvents(segment).filter(
                    (event) => event.firstFrame <= frame && event.lastFrame >= frame,
                ).length;
                for (let slot = 0; slot < maxRows; slot += 1) {
                    examples.push({ score: features[frame][slot], occupied: slot >= maxRows - count });
                }
            }
        }
        return calibrateThreshold(examples);
    }

    function calibrateGeometry(
        trainingSets,
        {
            minimumCenter = 9,
            maximumCenter = height - 10,
            errorMessage = "The ROI is too short for the configured maxRows and row geometry.",
        } = {},
    ) {
        let best;
        for (
            let bottomCenter = Math.round(height * 0.58);
            bottomCenter <= Math.round(height * 0.88);
            bottomCenter += 1
        ) {
            for (let spacing = Math.round(height * 0.11); spacing <= Math.round(height * 0.18); spacing += 1) {
                if (bottomCenter > maximumCenter || bottomCenter - (maxRows - 1) * spacing < minimumCenter) continue;
                const sets = trainingSets.map(({ segment, profiles }) => ({
                    segment,
                    features: extractFeatures(profiles, bottomCenter, spacing),
                }));
                const calibration = calibrateRowThreshold(sets);
                if (!best || calibration.errors < best.errors) {
                    best = { bottomCenter, spacing, ...calibration };
                }
            }
        }
        if (!best) throw new Error(errorMessage);
        return best;
    }

    function rowFingerprint(frame, centerY) {
        const left = Math.round(width * 0.27);
        const right = Math.round(width * 0.96);
        const quantityLeft = Math.round(width * 0.58);

        function project(startX) {
            const projection = new Uint8Array(right - startX);
            for (let x = startX; x < right; x += 1) {
                let brightPixels = 0;
                for (let y = centerY - 9; y <= centerY + 9; y += 1) {
                    const offset = (y * width + x) * 3;
                    const chroma =
                        Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
                        Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
                    if (luminance(frame, offset) >= 150 && chroma <= 40) brightPixels += 1;
                }
                projection[x - startX] = brightPixels;
            }
            return projection;
        }

        return { full: project(left), quantity: project(quantityLeft) };
    }

    function extractFingerprints(frames, bottomCenter, spacing) {
        return frames.map((frame) =>
            Array.from({ length: maxRows }, (_, index) =>
                rowFingerprint(frame, bottomCenter - (maxRows - index - 1) * spacing),
            ),
        );
    }

    function fingerprintDistance(left, right) {
        if (!left || !right) return 0;

        function cosineDistance(leftProjection, rightProjection) {
            let dot = 0;
            let leftLength = 0;
            let rightLength = 0;
            for (let index = 0; index < leftProjection.length; index += 1) {
                dot += leftProjection[index] * rightProjection[index];
                leftLength += leftProjection[index] ** 2;
                rightLength += rightProjection[index] ** 2;
            }
            if (leftLength === 0 || rightLength === 0) return leftLength === rightLength ? 0 : 1;
            return 1 - dot / Math.sqrt(leftLength * rightLength);
        }

        return Math.max(cosineDistance(left.full, right.full), cosineDistance(left.quantity, right.quantity));
    }

    function detectRows(features, fingerprints, geometry) {
        return features.map((scores, frame) => {
            const detected = scores.map((score) => score >= geometry.threshold);
            let count = 0;
            for (let slot = maxRows - 1; slot >= 0 && detected[slot]; slot -= 1) count += 1;
            const occupied = detected.map((_, slot) => slot >= maxRows - count);
            const observations = [];
            for (let slot = maxRows - count; slot < maxRows; slot += 1) {
                observations.push({
                    slot,
                    centerY: geometry.bottomCenter - (maxRows - slot - 1) * geometry.spacing,
                    score: scores[slot],
                    fingerprint: fingerprints[frame][slot],
                });
            }
            return {
                count: occupied.filter(Boolean).length,
                strength: scores.reduce((total, score, index) => total + (occupied[index] ? score : 0), 0),
                fingerprint: count === 0 ? undefined : fingerprints[frame][maxRows - 1],
                fingerprints: count === 0 ? [] : fingerprints[frame].slice(maxRows - count),
                observations,
            };
        });
    }

    function quantityImage(frame, centerY, threshold) {
        const left = Math.round(width * 0.25);
        const right = Math.round(width * 0.8);
        const top = centerY - 12;
        const bottom = centerY + 12;
        const scale = 4;
        const padding = 10;
        const imageWidth = (right - left) * scale + padding * 2;
        const imageHeight = (bottom - top) * scale + padding * 2;
        const pixels = Buffer.alloc(imageWidth * imageHeight, 255);
        for (let y = top; y < bottom; y += 1) {
            for (let x = left; x < right; x += 1) {
                const offset = (y * width + x) * 3;
                const chroma =
                    Math.max(frame[offset], frame[offset + 1], frame[offset + 2]) -
                    Math.min(frame[offset], frame[offset + 1], frame[offset + 2]);
                if (luminance(frame, offset) < threshold || chroma > 65) continue;
                for (let scaledY = 0; scaledY < scale; scaledY += 1) {
                    for (let scaledX = 0; scaledX < scale; scaledX += 1) {
                        const targetX = padding + (x - left) * scale + scaledX;
                        const targetY = padding + (y - top) * scale + scaledY;
                        pixels[targetY * imageWidth + targetX] = 0;
                    }
                }
            }
        }
        return Buffer.concat([Buffer.from(`P5\n${imageWidth} ${imageHeight}\n255\n`), pixels]);
    }

    return {
        calibrateGeometry,
        calibrateRowThreshold,
        decodeFrames,
        detectRows,
        extractFeatures,
        extractFingerprints,
        extractScoreProfiles,
        fingerprintDistance,
        luminance,
        quantityImage,
        rowFingerprint,
        rowScore,
    };
}
