import { useEffect, useId, useRef, useState } from "react";
import type { SessionEntry, SessionState } from "../../domain/session";
import dialogStyles from "../../views/LiveSession/LiveSession.module.css";
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
                className={dialogStyles.ToolDialog}
                aria-labelledby={titleId}
                onClose={() => setTarget(null)}
            >
                <header className={dialogStyles.DialogHeading}>
                    <h2 id={titleId}>Select consumable preset</h2>
                    <button type="button" className="button subtle" onClick={() => dialog.current?.close()}>
                        Close <kbd>Esc</kbd>
                    </button>
                </header>
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
