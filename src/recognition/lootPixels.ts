/** Integer luma that every loot detector and OCR threshold is tuned against. Changing it changes recognition. */
export function luminance(pixels: Uint8ClampedArray, offset: number) {
    return (pixels[offset] * 77 + pixels[offset + 1] * 150 + pixels[offset + 2] * 29) >> 8;
}

export function chroma(pixels: Uint8ClampedArray, offset: number) {
    return (
        Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) -
        Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2])
    );
}

/** Bright, unsaturated loot text that stands out from its darker neighbours two scaled pixels away. */
export function isGlyphPixel(pixels: Uint8ClampedArray, width: number, offset: number, strict = false, scale = 1) {
    const light = luminance(pixels, offset);
    const step = Math.round(2 * scale) * 4;
    const horizontal = Math.min(luminance(pixels, offset - step), luminance(pixels, offset + step));
    const vertical = Math.min(luminance(pixels, offset - width * step), luminance(pixels, offset + width * step));
    return (
        light >= (strict ? 140 : 115) &&
        chroma(pixels, offset) <= (strict ? 25 : 55) &&
        light - Math.min(horizontal, vertical) >= 18
    );
}
