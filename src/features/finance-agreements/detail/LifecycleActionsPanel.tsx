"use client";

import { DISABLED_BUTTON_STYLE } from "../format";
import type { AgreementActionState } from "./lifecycle-actions";

export type LifecycleDialogKey = "confirm" | "activate" | "revise" | "suspend" | "resume" | "end";

// The lifecycle action bar of the Overview. A button exists ONLY when the server-computed permissions and the version state allow it (nothing is
// rendered and then hidden). `Continue draft` and `Create revision` are the page header's primary actions and are not repeated here. There is no
// delete. Every action opens a confirmation dialog; nothing is sent from this bar directly.
export function LifecycleActionsPanel({ state, busy, onOpen, headerActionsExist }: { state: AgreementActionState; busy: boolean; onOpen: (key: LifecycleDialogKey) => void; headerActionsExist: boolean }) {
  const buttons: Array<{ key: LifecycleDialogKey; label: string; primary: boolean; show: boolean }> = [
    { key: "confirm", label: "Confirm Agreement", primary: true, show: state.canConfirm },
    { key: "activate", label: "Activate Agreement", primary: true, show: state.canActivate },
    { key: "resume", label: "Resume Agreement", primary: true, show: state.canResume },
    { key: "suspend", label: "Suspend Agreement", primary: false, show: state.canSuspend },
    { key: "end", label: "End Agreement", primary: false, show: state.canEnd },
  ];
  const visible = buttons.filter((button) => button.show);

  return (
    <section className="panel" style={{ marginBottom: 18 }} aria-label="Lifecycle actions">
      <div className="panelbody">
        <div className="actions" style={{ alignItems: "center" }}>
          {visible.map((button) => (
            <button key={button.key} type="button" className={button.primary ? "btn primary" : "btn"} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => onOpen(button.key)}>
              {button.label}
            </button>
          ))}
          {visible.length === 0 && <span className="foundationnote">{headerActionsExist ? "Use the buttons at the top of the page to continue the draft or create a revision." : state.note}</span>}
        </div>
        <p className="foundationnote" style={{ margin: "8px 0 0" }}>
          Every change asks for confirmation. Versions are never deleted: earlier versions stay readable.
        </p>
      </div>
    </section>
  );
}
