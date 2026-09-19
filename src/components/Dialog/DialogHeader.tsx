import styles from "./Dialog.module.css";

export function DialogHeader({
    titleId,
    title,
    closeLabel,
    onClose,
}: {
    titleId: string;
    title: string;
    closeLabel: string;
    onClose: () => void;
}) {
    return (
        <header className={styles.Header}>
            <h2 id={titleId}>{title}</h2>
            <button className="button subtle" type="button" aria-label={closeLabel} onClick={onClose}>
                Close <kbd>Esc</kbd>
            </button>
        </header>
    );
}
