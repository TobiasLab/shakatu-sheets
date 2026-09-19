import type { ComponentProps } from "react";
import styles from "./SelectionButton.module.css";

export function SelectionButton({
    selected,
    className = "",
    children,
    ...props
}: Omit<ComponentProps<"button">, "aria-pressed" | "type"> & { selected: boolean }) {
    return (
        <button {...props} type="button" aria-pressed={selected} className={`${styles.Button} ${className}`}>
            {children}
        </button>
    );
}
