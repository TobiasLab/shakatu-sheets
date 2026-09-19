import { useEffect, useRef } from "react";
import { ConsumablePresetPicker } from "../../components/ConsumablePresets/ConsumablePresetPicker";
import { EntryForm } from "../../components/EntryForm/EntryForm";
import { Icon } from "../../components/Icon/Icon";
import { MarniImport } from "../../components/MarniImport/MarniImport";
import type { LiveSessionController } from "../../hooks/useLiveSession";
import styles from "./LiveSession.module.css";

export function SessionTools({ controller, visible }: { controller: LiveSessionController; visible: boolean }) {
    const entryDialog = useRef<HTMLDialogElement>(null);
    const importDialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        if (!visible) {
            entryDialog.current?.close();
            importDialog.current?.close();
        }
    }, [visible]);

    return (
        <>
            <div className={styles.EntryTools}>
                <ConsumablePresetPicker
                    session={controller.session}
                    disabled={controller.editingDisabled || !visible}
                    onApply={(_session, entries) => {
                        controller.dispatch({ type: "apply-consumables", entries });
                        return true;
                    }}
                />
                <button
                    className="button"
                    type="button"
                    disabled={controller.editingDisabled}
                    onClick={() => {
                        entryDialog.current?.showModal();
                        entryDialog.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
                    }}
                >
                    <Icon name="plus" />
                    Add loot or expense
                </button>
                <button
                    className="button"
                    type="button"
                    disabled={controller.editingDisabled}
                    onClick={() => importDialog.current?.showModal()}
                >
                    <Icon name="upload" />
                    Import a screenshot
                </button>
            </div>

            <dialog className={styles.ToolDialog} ref={entryDialog} aria-labelledby="entry-dialog-title">
                <header className={styles.DialogHeading}>
                    <div>
                        <h2 id="entry-dialog-title">Add loot or expense</h2>
                        <p>Choose an item, enter its quantity, and add it to your session.</p>
                    </div>
                    <button
                        className="button subtle"
                        type="button"
                        onClick={() => entryDialog.current?.close()}
                        aria-label="Close manual entry"
                    >
                        Close <kbd>Esc</kbd>
                    </button>
                </header>
                <EntryForm key={controller.session.id} {...controller} />
            </dialog>
            <dialog className={styles.ToolDialog} ref={importDialog} aria-labelledby="import-dialog-title">
                <header className={styles.DialogHeading}>
                    <div>
                        <h2 id="import-dialog-title">Import a screenshot</h2>
                        <p>Read a cropped Marni tracker screenshot, then review before importing.</p>
                    </div>
                    <button
                        className="button subtle"
                        type="button"
                        onClick={() => importDialog.current?.close()}
                        aria-label="Close screenshot import"
                    >
                        Close <kbd>Esc</kbd>
                    </button>
                </header>
                <MarniImport key={controller.session.id} controller={controller} />
            </dialog>
        </>
    );
}
