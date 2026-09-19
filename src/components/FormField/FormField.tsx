import type { ReactNode } from "react";
import styles from "./FormField.module.css";

export function FormField({
    label,
    children,
    className = "",
}: {
    label: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        // biome-ignore lint/a11y/noLabelWithoutControl: The caller supplies a native input, select, or textarea inside this label.
        <label className={`${styles.Field} ${className}`}>
            <span>{label}</span>
            {children}
        </label>
    );
}
