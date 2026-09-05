// Compare shape rather than column totals. Inputs are binary OCR images (black ink on white).
export function lootGlyphDistance(left, right, verticalTolerance = 0) {
    const { width, height } = left;
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width !== right.width ||
        height !== right.height ||
        left.pixels.length !== width * height * 4 ||
        right.pixels.length !== width * height * 4
    ) {
        throw new Error("Glyph comparison images must have matching dimensions and RGBA buffers.");
    }
    if (!Number.isSafeInteger(verticalTolerance) || verticalTolerance < 0 || verticalTolerance >= height) {
        throw new Error("Vertical tolerance must be a nonnegative integer smaller than the image height.");
    }
    let leftInk = 0;
    let rightInk = 0;
    for (let offset = 0; offset < left.pixels.length; offset += 4) {
        if (left.pixels[offset] === 0) leftInk += 1;
        if (right.pixels[offset] === 0) rightInk += 1;
    }
    if (leftInk === 0 || rightInk === 0) return null;
    let bestIntersection = 0;
    for (let shift = -verticalTolerance; shift <= verticalTolerance; shift += 1) {
        let intersection = 0;
        for (let y = Math.max(0, -shift); y < Math.min(height, height - shift); y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (left.pixels[(y * width + x) * 4] === 0 && right.pixels[((y + shift) * width + x) * 4] === 0) {
                    intersection += 1;
                }
            }
        }
        bestIntersection = Math.max(bestIntersection, intersection);
    }
    // Keep all ink in the denominator: moving a stroke outside the overlap must not hide disagreement.
    return 1 - bestIntersection / Math.sqrt(leftInk * rightInk);
}
