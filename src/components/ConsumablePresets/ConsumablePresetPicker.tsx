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
    onApply: (snapshot: SessionState, entries: SessionEntry[]) => boolean | Promise<boolean>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const [target, setTarget] = useState<SessionState | null>(null);
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
                    setTarget(session);
                    dialog.current?.showModal();
                }}
            >
                Apply preset
            </button>
            <dialog
                ref={dialog}
                className={`${dialogStyles.ToolDialog} ${dialogStyles.NarrowDialog}`}
                aria-labelledby={titleId}
                onClose={() => setTarget(null)}
            >
                <DialogHeader
                    titleId={titleId}
                    title="Select consumable preset"
                    closeLabel="Close consumable presets"
                    onClose={() => dialog.current?.close()}
                />
                {target && (
                    <ConsumablePresetSelection
                        session={target}
                        disabled={disabled}
                        onApply={async (entries) => {
                            const applied = await onApply(target, entries);
                            if (applied) dialog.current?.close();
                            return applied;
                        }}
                    />
                )}
            </dialog>
        </>
    );
}
