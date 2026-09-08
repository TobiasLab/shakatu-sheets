// Synthetic formatting comparison; this does not measure game FPS or whole-app CPU usage.
// Run: npm exec vite-node -- scripts/benchmark-session-format.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { formatSilver } from "../src/format";

function previousFormat(value, compact) {
    return compact
        ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value)
        : new Intl.NumberFormat("en").format(Math.round(value));
}

for (const entries of [0, 30, 300]) {
    const values = [123_456_789, ...Array.from({ length: entries }, (_, i) => (i + 1) * 19_231)];
    for (const value of values) {
        for (const compact of [false, true]) assert.equal(formatSilver(value, compact), previousFormat(value, compact));
    }
    function measure(format) {
        const samples = [];
        for (let sample = 0; sample < 5; sample++) {
            const start = performance.now();
            for (let repeat = 0; repeat < 100; repeat++) {
                for (const value of values) {
                    format(value, false);
                    format(value, true);
                }
            }
            samples.push(performance.now() - start);
        }
        return samples.sort((a, b) => a - b)[2];
    }
    console.info(
        JSON.stringify({
            entries,
            calls: values.length * 200,
            previousMs: measure(previousFormat),
            cachedMs: measure(formatSilver),
        }),
    );
}
