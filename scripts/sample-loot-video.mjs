import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const arguments_ = process.argv.slice(2);
if (arguments_.includes("--help") || arguments_.length === 0) {
    console.log("Usage: npm run benchmark:loot:sample -- <manifest.json> [--output <directory>]");
    process.exit(arguments_.length === 0 ? 1 : 0);
}

const manifestPath = resolve(arguments_[0]);
const outputOption = arguments_.indexOf("--output");
if (arguments_.length !== 1 && (arguments_.length !== 3 || outputOption !== 1)) {
    throw new Error("Expected a manifest path followed by an optional --output directory.");
}

const manifestDirectory = dirname(manifestPath);
const outputDirectory = resolve(
    outputOption === -1 ? join(manifestDirectory, "benchmark-output") : arguments_[outputOption + 1],
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function positiveNumber(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${field} must be a positive number.`);
    }
    return value;
}

function positiveInteger(value, field) {
    positiveNumber(value, field);
    if (!Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
    return value;
}

function validateManifest(value) {
    if (value.version !== 1) throw new Error("manifest.version must be 1.");
    if (typeof value.source !== "string" || value.source.length === 0) {
        throw new Error("manifest.source must name a video file.");
    }
    positiveInteger(value.display?.width, "manifest.display.width");
    positiveInteger(value.display?.height, "manifest.display.height");
    positiveInteger(value.recording?.width, "manifest.recording.width");
    positiveInteger(value.recording?.height, "manifest.recording.height");
    positiveNumber(value.uiScalePercent, "manifest.uiScalePercent");
    const sampleFps = positiveNumber(value.sampleFps, "manifest.sampleFps");
    if (sampleFps > 60) throw new Error("manifest.sampleFps must not exceed 60.");
    positiveInteger(value.maxRows, "manifest.maxRows");
    if (value.itemDictionary !== undefined) {
        if (
            !Array.isArray(value.itemDictionary) ||
            value.itemDictionary.length === 0 ||
            value.itemDictionary.some((item) => typeof item !== "string" || item.length === 0)
        ) {
            throw new Error("manifest.itemDictionary must contain item names when provided.");
        }
        if (new Set(value.itemDictionary).size !== value.itemDictionary.length) {
            throw new Error("manifest.itemDictionary must not contain duplicate item names.");
        }
    }

    for (const field of ["x", "y", "width", "height"]) {
        const coordinate = value.roi?.[field];
        if (typeof coordinate !== "number" || coordinate < 0 || coordinate > 1) {
            throw new Error(`manifest.roi.${field} must be between 0 and 1.`);
        }
    }
    if (value.roi.width === 0 || value.roi.height === 0 || value.roi.x + value.roi.width > 1) {
        throw new Error("manifest.roi must have a positive width and remain inside the video.");
    }
    if (value.roi.y + value.roi.height > 1) {
        throw new Error("manifest.roi must have a positive height and remain inside the video.");
    }
    if (!Array.isArray(value.segments) || value.segments.length === 0) {
        throw new Error("manifest.segments must contain at least one segment.");
    }

    const ids = new Set();
    for (const [index, segment] of value.segments.entries()) {
        if (typeof segment.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(segment.id)) {
            throw new Error(`manifest.segments[${index}].id must use lowercase letters, numbers, and hyphens.`);
        }
        if (ids.has(segment.id)) throw new Error(`Duplicate segment id: ${segment.id}.`);
        ids.add(segment.id);
        positiveNumber(segment.endSeconds, `manifest.segments[${index}].endSeconds`);
        if (typeof segment.startSeconds !== "number" || segment.startSeconds < 0) {
            throw new Error(`manifest.segments[${index}].startSeconds must be zero or greater.`);
        }
        if (segment.endSeconds <= segment.startSeconds) {
            throw new Error(`manifest.segments[${index}] must end after it starts.`);
        }
        if (!["development", "validation", "test"].includes(segment.split)) {
            throw new Error(`manifest.segments[${index}].split must be development, validation, or test.`);
        }
        if (segment.events !== undefined && !Array.isArray(segment.events)) {
            throw new Error(`manifest.segments[${index}].events must be an array when provided.`);
        }
        const eventIds = new Set();
        for (const [eventIndex, event] of (segment.events ?? []).entries()) {
            const field = `manifest.segments[${index}].events[${eventIndex}]`;
            if (typeof event.id !== "string" || event.id.length === 0) throw new Error(`${field}.id must be a string.`);
            if (eventIds.has(event.id)) throw new Error(`Duplicate event id in ${segment.id}: ${event.id}.`);
            eventIds.add(event.id);
            if (typeof event.item !== "string" || event.item.length === 0) {
                throw new Error(`${field}.item must be a string.`);
            }
            if (value.itemDictionary && !value.itemDictionary.includes(event.item)) {
                throw new Error(`${field}.item must appear in manifest.itemDictionary.`);
            }
            positiveInteger(event.quantity, `${field}.quantity`);
            for (const frameField of ["firstFrame", "stableFrame", "lastFrame"]) {
                if (!Number.isInteger(event[frameField]) || event[frameField] < 0) {
                    throw new Error(`${field}.${frameField} must be a non-negative integer.`);
                }
            }
            if (event.stableFrame < event.firstFrame || event.lastFrame < event.stableFrame) {
                throw new Error(`${field} frame bounds must be ordered.`);
            }
            if (event.baseline !== undefined && typeof event.baseline !== "boolean") {
                throw new Error(`${field}.baseline must be a boolean when provided.`);
            }
            if (event.baseline && event.firstFrame !== 0) {
                throw new Error(`${field}.firstFrame must be 0 for a baseline row.`);
            }
            if (event.truncated !== undefined && typeof event.truncated !== "boolean") {
                throw new Error(`${field}.truncated must be a boolean when provided.`);
            }
        }
    }
}

function run(command, parameters, captureOutput = false) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, parameters, { stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit" });
        const stdout = [];
        const stderr = [];
        child.stdout?.on("data", (chunk) => stdout.push(chunk));
        child.stderr?.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => rejectRun(new Error(`Could not start ${command}: ${error.message}`)));
        child.on("exit", (code) => {
            if (code === 0) {
                resolveRun(Buffer.concat(stdout).toString("utf8"));
                return;
            }
            rejectRun(new Error(`${command} exited with code ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        });
    });
}

validateManifest(manifest);
const source = resolve(manifestDirectory, manifest.source);
const probe = JSON.parse(
    await run(
        "ffprobe",
        [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,avg_frame_rate:format=duration",
            "-of",
            "json",
            source,
        ],
        true,
    ),
);
const video = probe.streams?.[0];
if (!video) throw new Error("The source contains no video stream.");
if (video.width !== manifest.recording.width || video.height !== manifest.recording.height) {
    throw new Error(
        `Expected a ${manifest.recording.width}x${manifest.recording.height} recording, got ${video.width}x${video.height}.`,
    );
}
const durationSeconds = Number(probe.format?.duration);
positiveNumber(durationSeconds, "probed video duration");

const left = Math.floor(manifest.roi.x * video.width);
const top = Math.floor(manifest.roi.y * video.height);
const right = Math.ceil((manifest.roi.x + manifest.roi.width) * video.width);
const bottom = Math.ceil((manifest.roi.y + manifest.roi.height) * video.height);
const crop = { x: left, y: top, width: right - left, height: bottom - top };
const generatedSegments = [];

await mkdir(outputDirectory, { recursive: true });
for (const segment of manifest.segments) {
    if (segment.endSeconds > durationSeconds) {
        throw new Error(`Segment ${segment.id} ends after the ${durationSeconds.toFixed(3)} second source duration.`);
    }
    const segmentDirectory = join(outputDirectory, segment.id);
    await rm(segmentDirectory, { recursive: true, force: true });
    await mkdir(segmentDirectory, { recursive: true });
    await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(segment.startSeconds),
        "-i",
        source,
        "-t",
        String(segment.endSeconds - segment.startSeconds),
        "-an",
        "-vf",
        `fps=${manifest.sampleFps}:start_time=0,crop=w=${crop.width}:h=${crop.height}:x=${crop.x}:y=${crop.y}:exact=1`,
        "-start_number",
        "0",
        join(segmentDirectory, "frame-%06d.png"),
    ]);
    const frameCount = (await readdir(segmentDirectory)).filter((file) => /^frame-\d{6}\.png$/.test(file)).length;
    for (const event of segment.events ?? []) {
        if (event.lastFrame >= frameCount) {
            throw new Error(`${segment.id} event ${event.id} ends outside its ${frameCount} generated frames.`);
        }
    }
    for (let frame = 0; frame < frameCount; frame += 1) {
        const visibleRows = (segment.events ?? []).filter(
            (event) => event.firstFrame <= frame && event.lastFrame >= frame,
        ).length;
        if (visibleRows > manifest.maxRows) {
            throw new Error(`${segment.id} frame ${frame} has ${visibleRows} rows, exceeding maxRows ${manifest.maxRows}.`);
        }
    }
    await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        String(manifest.sampleFps),
        "-i",
        join(segmentDirectory, "frame-%06d.png"),
        "-vf",
        "scale=iw*3:ih*3:flags=lanczos,drawtext=text='frame %{n}':x=8:y=8:fontsize=24:fontcolor=white:borderw=2:bordercolor=black,tile=4x5:padding=2:margin=2",
        "-q:v",
        "2",
        "-fps_mode",
        "vfr",
        join(segmentDirectory, "contact-%02d.jpg"),
    ]);
    generatedSegments.push({
        ...segment,
        frameCount,
        directory: segment.id,
        framePattern: "frame-%06d.png",
        contactPattern: "contact-%02d.jpg",
    });
    console.log(`${segment.id}: ${frameCount} frames`);
}

const generatedManifest = {
    version: 1,
    source: basename(source),
    sourceDurationSeconds: durationSeconds,
    sourceCodec: video.codec_name,
    sourceFrameRate: video.avg_frame_rate,
    display: manifest.display,
    recording: { width: video.width, height: video.height },
    uiScalePercent: manifest.uiScalePercent,
    sampleFps: manifest.sampleFps,
    maxRows: manifest.maxRows,
    itemDictionary: manifest.itemDictionary,
    roi: { normalized: manifest.roi, pixels: crop },
    segments: generatedSegments,
};
await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(generatedManifest, null, 4)}\n`);
console.log(`Wrote benchmark frames to ${outputDirectory}`);
