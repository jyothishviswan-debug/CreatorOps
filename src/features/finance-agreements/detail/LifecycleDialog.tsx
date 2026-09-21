"use client";

import { useState } from "react";
import Link from "next/link";

import { DialogShell } from "@/ui/Dialog";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import type { FinanceApiBlocker } from "../api-client";
import { describeConfirmBlockers } from "../confirm-blockers";
import { DISABLED_BUTTON_STYLE } from "../format";
import { intakeHref } from "./detail-model";
import type { LifecycleDialogKey } from "./LifecycleActionsPanel";
import { REASON_MAX_LENGTH, reasonIssue } from "./lifecycle-actions";

const TITLES: Record<LifecycleDialogKey, string> = {
  confirm: "Confirm this Agreement version?",
  activate: "Activate this version?",
  revise: "Create a revision?",
  suspend: "Suspend this Agreement?",
  resume: "Resume this Agreement?",
  end: "End this Agreement?",
};

const SUBMIT_LABELS: Record<LifecycleDialogKey, { idle: string; busy: string }> = {
  confirm: { idle: "Confirm Agreement", busy: "Confirming…" },
  activate: { idle: "Activate Agreement", busy: "Activating…" },
  revise: { idle: "Create revision", busy: "Creating…" },
  suspend: { idle: "Suspend Agreement", busy: "Suspending…" },
  resume: { idle: "Resume Agreement", busy: "Resuming…" },
  end: { idle: "End Agreement", busy: "Ending…" },
};

export type LifecycleDialogProps = {
  dialog: LifecycleDialogKey | null;
  // The dialog whose request is in flight (null when idle): the dialog cannot be dismissed while it runs.
  busy: LifecycleDialogKey | null;
  error: string | null;
  blockers: FinanceApiBlocker[] | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  agreementRef: string;
  counterpartyType: CounterpartyType;
  counterpartyName: string;
  openVersion: number | null;
  governingVersion: number | null;
  latestVersion: number;
  canManage: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

// ONE confirmation dialog for every lifecycle change (only one can be open). It cannot be dismissed while a request is running, the submit
// button is disabled (and visibly so) while it runs or while a required reason is missing, and a failure is shown here without closing it.
export function LifecycleDialog(props: LifecycleDialogProps) {
  const { dialog, busy, error, blockers, reason } = props;
  const running = busy !== null;
  const needsReason = dialog === "suspend" || dialog === "end";
  const reasonProblem = needsReason ? reasonIssue(reason) : null;
  const submitDisabled = running || reasonProblem !== null;
  const labels = dialog ? SUBMIT_LABELS[dialog] : SUBMIT_LABELS.confirm;
  // Escape closes a native dialog and cannot be vetoed. While a request runs, that close is undone by re-mounting the (still open) dialog,
  // so the person never loses sight of the running action or its result.
  const [reopenKey, setReopenKey] = useState(0);

  return (
    <DialogShell
      key={reopenKey}
      open={dialog !== null}
      title={dialog ? TITLES[dialog] : ""}
      onClose={() => {
        if (running) setReopenKey((value) => value + 1);
        else props.onClose();
      }}
      footer={
        dialog ? (
          <>
            <button type="button" className="btn" onClick={props.onClose} disabled={running} style={running ? DISABLED_BUTTON_STYLE : undefined}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={props.onSubmit} disabled={submitDisabled} style={submitDisabled ? DISABLED_BUTTON_STYLE : undefined}>
              {running ? labels.busy : labels.idle}
            </button>
          </>
        ) : null
      }
    >
      {dialog && <DialogCopy {...props} dialog={dialog} reasonProblem={reasonProblem} running={running} />}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      {blockers && blockers.length > 0 && <BlockerList {...props} blockers={blockers} />}
    </DialogShell>
  );
}

function DialogCopy(props: LifecycleDialogProps & { dialog: LifecycleDialogKey; reasonProblem: string | null; running: boolean }) {
  const { dialog, openVersion, governingVersion, latestVersion, counterpartyName, reason, reasonProblem, running } = props;
  switch (dialog) {
    case "confirm":
      return (
        <>
          <p className="detailcopy">
            Version {openVersion} of the Agreement with {counterpartyName} will be confirmed: its terms are frozen exactly as decided and can no longer be edited.
          </p>
          <p className="foundationnote">Every proposed value must already be decided. If something is missing you will see exactly what, and where to fix it. Confirming does not activate the Agreement.</p>
        </>
      );
    case "activate":
      return (
        <>
          <p className="detailcopy">
            Version {openVersion} becomes the version in force for {counterpartyName}.
            {governingVersion !== null ? ` Version ${governingVersion} is marked Superseded and stays readable.` : ""}
          </p>
          <p className="foundationnote">Terms are frozen. A later change needs a new revision.</p>
        </>
      );
    case "revise":
      return (
        <>
          <p className="detailcopy">
            A new editable draft (version {latestVersion + 1}) is created from the confirmed terms of version {governingVersion ?? latestVersion}. You will review and change it in the intake form.
          </p>
          <p className="foundationnote">Version {governingVersion ?? latestVersion} stays unchanged and readable until the replacement is confirmed and activated. Nothing changes silently.</p>
        </>
      );
    case "resume":
      return (
        <p className="detailcopy">
          Version {governingVersion} of the Agreement with {counterpartyName} returns to Active.
        </p>
      );
    default:
      return (
        <>
          <p className="detailcopy">
            {dialog === "end"
              ? `Ending closes version ${governingVersion} of the Agreement with ${counterpartyName}. This cannot be undone or resumed. It stays readable, and a new revision can start new terms.`
              : `Version ${governingVersion} of the Agreement with ${counterpartyName} is put on hold. It stays the version in force but is marked Suspended until it is resumed or ended.`}
          </p>
          {dialog === "end" && (
            <div className="banner" role="note" style={{ margin: "0 0 10px" }}>
              <span>
                <b>Ending is permanent.</b> An ended Agreement cannot be resumed.
              </span>
            </div>
          )}
          <div className="field">
            <label htmlFor="lifecycle-reason">
              Reason <span style={{ color: "var(--orange)" }}>*</span>
            </label>
            <textarea
              id="lifecycle-reason"
              rows={3}
              maxLength={REASON_MAX_LENGTH + 200}
              value={reason}
              autoFocus
              disabled={running}
              aria-describedby="lifecycle-reason-hint"
              aria-invalid={reason.length > 0 && reasonProblem !== null}
              onChange={(event) => props.onReasonChange(event.target.value)}
            />
            <small id="lifecycle-reason-hint" aria-live="polite">
              {reasonProblem && reason.length > 0 ? reasonProblem : "Recorded in the Agreement's activity. Do not include KYC or amounts."}
            </small>
          </div>
        </>
      );
  }
}

// The confirm gate's blockers, in plain language, each with a link straight to the field in the intake form.
function BlockerList({ blockers, agreementRef, counterpartyType, openVersion, canManage }: { blockers: FinanceApiBlocker[] } & Pick<LifecycleDialogProps, "agreementRef" | "counterpartyType" | "openVersion" | "canManage">) {
  const views = describeConfirmBlockers(blockers, counterpartyType);
  return (
    <div className="banner" role="alert" style={{ marginTop: 10, display: "block" }}>
      <b>Not ready to confirm.</b> Resolve {views.length === 1 ? "this" : "these"} first:
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {views.map((view, index) => (
          <li key={`${view.code}-${view.anchorId}-${index}`}>
            {view.message}{" "}
            {canManage && (
              <Link href={intakeHref(agreementRef, openVersion, view.anchorId)} className="textlink">
                Go to field
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
