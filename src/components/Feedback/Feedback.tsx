import type { ReactNode } from "react";
import { Icon } from "../Icon/Icon";
import styles from "./Feedback.module.css";

export function Feedback({
    children,
    tone = "status",
    action,
    id,
}: {
    children: ReactNode;
    tone?: "status" | "success" | "error";
    action?: ReactNode;
    id?: string;
}) {
    return (
        <div className={styles.Feedback} data-tone={tone}>
            <p id={id} role={tone === "error" ? "alert" : "status"}>
                {children}
            </p>
            {action}
        </div>
    );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
    return (
        <div className={styles.Empty}>
            <span className={styles.EmptyIcon}>
                <Icon name="desk" size={24} />
            </span>
            <strong role="status">{title}</strong>
            {children && <p>{children}</p>}
            {action}
        </div>
    );
}
