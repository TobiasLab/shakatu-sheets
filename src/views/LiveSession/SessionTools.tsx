import { useEffect, useRef } from "react";
import { ConsumablePresetPicker } from "../../components/ConsumablePresets/ConsumablePresetPicker";
import { DialogHeader } from "../../components/Dialog/DialogHeader";
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
                    onApply={(entries) => controller.dispatch({ type: "apply-consumables", entries })}
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
                <DialogHeader
                    titleId="entry-dialog-title"
                    title="Add loot or expense"
                    closeLabel="Close manual entry"
                    onClose={() => entryDialog.current?.close()}
                />
                <EntryForm key={controller.session.id} {...controller} />
            </dialog>
            <dialog className={styles.ToolDialog} ref={importDialog} aria-labelledby="import-dialog-title">
                <DialogHeader
                    titleId="import-dialog-title"
                    title="Import a screenshot"
                    closeLabel="Close screenshot import"
                    onClose={() => importDialog.current?.close()}
                />
                <MarniImport key={controller.session.id} controller={controller} />
            </dialog>
        </>
    );
}
