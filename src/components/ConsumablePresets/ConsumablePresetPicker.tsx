import { useEffect, useId, useRef, useState } from "react";
import type { SessionEntry, SessionState } from "../../domain/session";
import dialogStyles from "../../views/LiveSession/LiveSession.module.css";
import { DialogHeader } from "../Dialog/DialogHeader";
import { ConsumablePresetSelection } from "./ConsumablePresetSelection";

export function ConsumablePresetPicker({
    session,
    disabled,
    onApply,
}: {
    session: SessionState;
    disabled: boolean;
    onApply: (entries: SessionEntry[]) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    // The selection mounts per opening, so each opening starts without a previous choice.
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (disabled) dialog.current?.close();
    }, [disabled]);
    return (
        <>
            <button
                className="button"
                type="button"
                disabled={disabled}
                onClick={() => {
                    setOpen(true);
                    dialog.current?.showModal();
                }}
            >
                Apply preset
            </button>
            <dialog
                ref={dialog}
                className={`${dialogStyles.ToolDialog} ${dialogStyles.NarrowDialog}`}
                aria-labelledby={titleId}
                onClose={() => setOpen(false)}
            >
                <DialogHeader
                    titleId={titleId}
                    title="Select consumable preset"
                    closeLabel="Close consumable presets"
                    onClose={() => dialog.current?.close()}
                />
                {open && (
                    <ConsumablePresetSelection
                        session={session}
                        disabled={disabled}
                        onApply={(entries) => {
                            onApply(entries);
                            dialog.current?.close();
                        }}
                    />
                )}
            </dialog>
        </>
    );
}
