import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { adjustSessionOverlay } from "../../api/sessionOverlay";

// Keep the surface stationary during the gesture: Wayland does not expose
// global pointer coordinates. Applying the delta on release avoids feedback
// between moving the surface and the pointer's surface-local coordinates.
export function useOverlayPlacement(action: "move" | "resize", onError: (error: string) => void) {
    const gesture = useRef<{ id: number; x: number; y: number } | null>(null);
    const [active, setActive] = useState(false);
    const cancel = () => {
        gesture.current = null;
        setActive(false);
    };
    const apply = (dx: number, dy: number) => {
        if (dx || dy) void adjustSessionOverlay(action, dx, dy).catch((error) => onError(String(error)));
    };
    return {
        active,
        onPointerDown(event: PointerEvent<HTMLButtonElement>) {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            setActive(true);
        },
        onPointerUp(event: PointerEvent<HTMLButtonElement>) {
            const start = gesture.current;
            if (!start || start.id !== event.pointerId) return;
            cancel();
            if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            apply(event.clientX - start.x, event.clientY - start.y);
        },
        onPointerCancel() {
            cancel();
        },
        onLostPointerCapture() {
            cancel();
        },
        onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
            if (event.key === "Escape") {
                cancel();
                return;
            }
            const step = event.shiftKey ? 64 : 16;
            const delta: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };
            if (delta[event.key]) {
                event.preventDefault();
                apply(...delta[event.key]);
            }
        },
    };
}
