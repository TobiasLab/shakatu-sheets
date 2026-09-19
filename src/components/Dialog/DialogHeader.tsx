import styles from "./Dialog.module.css";

export function DialogHeader({
    titleId,
    title,
    closeLabel,
    onClose,
    disabled = false,
}: {
    titleId: string;
    title: string;
    closeLabel: string;
    onClose: () => void;
    disabled?: boolean;
}) {
    return (
        <header className={styles.Header}>
            <h2 id={titleId}>{title}</h2>
            <button
                className="button subtle"
                type="button"
                aria-label={closeLabel}
                disabled={disabled}
                onClick={onClose}
            >
                Close <kbd>Esc</kbd>
            </button>
        </header>
    );
}
