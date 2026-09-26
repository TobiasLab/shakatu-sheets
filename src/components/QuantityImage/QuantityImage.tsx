import { useEffect, useRef } from "react";
import type { LootRoiFrame } from "../../recognition/liveLoot";
import styles from "./QuantityImage.module.css";

export function QuantityImage({
    image,
    label = "Quantity image for self-improvement",
}: {
    label?: string;
    image: Pick<LootRoiFrame, "width" | "height"> & { pixels: ArrayLike<number> };
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const context = canvas.current?.getContext("2d");
        if (!context) return;
        const data = context.createImageData(image.width, image.height);
        data.data.set(Array.from(image.pixels));
        context.putImageData(data, 0, 0);
    }, [image]);
    return (
        <canvas className={styles.Image} ref={canvas} width={image.width} height={image.height} aria-label={label} />
    );
}
