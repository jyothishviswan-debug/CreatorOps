"use client";

// Step 14B intake, section 10 `Review & confirm`: a concise grouped summary of the draft, what still blocks confirmation (with jump
// links), and the actions. `Save Draft` lives in the form footer directly below this section (one button, not two) and saves the buffered edits. `Confirm Agreement` freezes this version's terms and is disabled,
// with its reason shown, while items are unresolved. `Activate Agreement` exists ONLY when the server says this person may activate AND the
// version is confirmed - otherwise it is absent (nothing is revealed and then hidden). Saving or confirming never writes master data.
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";

import { DialogShell } from "@/ui/Dialog";

import { KeyValueRow } from "../components/KeyValueRow";
import { StatusChip } from "../components/StatusChip";
import { blockerHeadline } from "../confirm-blockers";
import { DISABLED_BUTTON_STYLE, fieldLabel, lifecycleChip, type ChipSpec } from "../format";
import { commercialIssues } from "./editors/commercial-logic";
import { INTAKE_BUSY, useIntake } from "./intake-context";
import { buildReadiness, buildReviewGroups, confirmDisabledReason, draftResolver, frozenResolver, type ReviewGroup } from "./review-summary";
import { SectionCard } from "./SectionCard";

const BLOCKERS_ID = "review-blockers";
const CARD_GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12, alignItems: "start" } as const;

type DialogKind = "confirm" | "activate" | null;

export function ReviewConfirmSection() {
  const intake = useIntake();
  const { flags, version, agreement, counterparty, fieldModels, localEdits, artifact, extraction, extractionAttached, kyc, preview, unresolvedFields, confirmBlockers, revisionDiff, revisionBaseVersion, agreementRef } = intake;
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const reasonId = useId();

  const confirmed = !!version?.confirmed;
  const resolve = useMemo(() => (version && confirmed ? frozenResolver(version) : draftResolver(fieldModels, localEdits)), [version, confirmed, fieldModels, localEdits]);
  const groups = useMemo(
    () =>
      buildReviewGroups({
        counterparty,
        version,
        resolve,
        models: fieldModels,
        artifact,
        extractionStatus: extraction?.run.status ?? null,
        extractionAttached,
        unresolvedCount: confirmed ? 0 : unresolvedFields.filter((field) => localEdits[field.fieldKey] === undefined).length,
        kyc: kyc ?? (preview ? { state: preview.kyc.state, components: preview.kyc.components } : null),
        fieldLabel,
      }),
    [counterparty, version, resolve, fieldModels, artifact, extraction, extractionAttached, confirmed, unresolvedFields, localEdits, kyc, preview],
  );
  const issues = useMemo(() => (confirmed ? [] : commercialIssues(resolve)), [confirmed, resolve]);
  const readiness = useMemo(() => (confirmed ? [] : buildReadiness({ unresolved: unresolvedFields, localEdits, commercialIssues: issues })), [confirmed, unresolvedFields, localEdits, issues]);
  const disabledReason = confirmDisabledReason(readiness);

  // A refused confirm brings the person to the list of what is missing.
  useEffect(() => {
    if (confirmBlockers.length > 0) intake.scrollToAnchor(BLOCKERS_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a NEW set of blockers arrives
  }, [confirmBlockers]);

  if (!agreement || !version || !counterparty) return null;

  const busy = intake.isBusy();
  const confirming = intake.isBusy(INTAKE_BUSY.confirm);
  const activating = intake.isBusy(INTAKE_BUSY.activate);
  const headStatus = agreement.head.status;

  const chip: ChipSpec = confirmed ? (headStatus === "DRAFT" ? { label: "Confirmed · not active", tone: "blue" } : lifecycleChip(headStatus)) : readiness.length > 0 ? { label: `${readiness.length} to resolve`, tone: "orange" } : { label: "Ready to confirm", tone: "default" };

  const closeDialog = (key: "confirm" | "activate") => {
    if (intake.isBusy(key === "confirm" ? INTAKE_BUSY.confirm : INTAKE_BUSY.activate)) return;
    setDialog((current) => (current === key ? null : current));
    setDialogError(null);
  };

  const runConfirm = async () => {
    setDialogError(null);
    const result = await intake.confirmAgreement();
    if (result.ok) setDialog(null);
    else if (result.aborted) return;
    else if (result.kind === "not_ready") setDialog(null);
    else setDialogError(result.message);
  };

  const runActivate = async () => {
    setDialogError(null);
    const result = await intake.activateAgreement();
    if (result.ok) setDialog(null);
    else if (!result.aborted) setDialogError(result.message);
  };

  return (
    <SectionCard sectionKey="review" description="Check the summary, resolve anything that still needs a decision, then confirm. Confirming freezes this version's terms." chip={chip}>
      {flags.isRevision && revisionDiff && (
        <section className="scopebox" style={{ marginTop: 0, marginBottom: 14 }} aria-label="Changes from the previous version" data-testid="revision-changes">
          <b>{`Changes from version ${revisionBaseVersion ?? "the previous one"}`}</b>
          {revisionDiff.length === 0 ? (
            <p style={{ margin: "6px 0 0" }}>Nothing differs from the previous confirmed version yet.</p>
          ) : (
            <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
              {revisionDiff.map((change) => (
                <li key={change.fieldKey} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline", overflowWrap: "anywhere" }}>
                  <button type="button" className="btn ghost" style={{ minHeight: 24, padding: "0 6px", textDecoration: "underline" }} onClick={() => intake.scrollToAnchor(`field-${change.fieldKey}`)}>
                    {change.label}
                  </button>
                  <span className="muted">{`${change.beforeText} → ${change.afterText}`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div style={CARD_GRID} data-testid="review-summary">
        {groups.map((group) => (
          <GroupCard key={group.key} group={group} onJump={(anchorId) => intake.scrollToAnchor(anchorId)} />
        ))}
      </div>

      <div id={BLOCKERS_ID} tabIndex={-1} style={{ marginTop: 14, outline: "none" }}>
        {confirmBlockers.length > 0 && (
          <div className="banner" role="alert" style={{ display: "grid", gap: 8, alignItems: "start" }} data-testid="confirm-blockers">
            <b>{blockerHeadline(confirmBlockers.length)}</b>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
              {confirmBlockers.map((blocker) => (
                <li key={`${blocker.anchorId}-${blocker.message}`}>
                  {blocker.message}{" "}
                  <button type="button" className="btn ghost" style={{ minHeight: 24, padding: "0 6px", textDecoration: "underline" }} onClick={() => intake.goToBlocker(blocker)}>
                    Go to it
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {confirmBlockers.length === 0 && readiness.length > 0 && (
          <div className="scopebox" style={{ marginTop: 0 }} data-testid="readiness">
            <b>{disabledReason}</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 3 }}>
              {readiness.slice(0, 8).map((item) => (
                <li key={`${item.anchorId}-${item.message}`}>
                  {item.message}{" "}
                  <button type="button" className="btn ghost" style={{ minHeight: 24, padding: "0 6px", textDecoration: "underline" }} onClick={() => intake.scrollToAnchor(item.anchorId)}>
                    Go to it
                  </button>
                </li>
              ))}
              {readiness.length > 8 && <li className="muted">{`+${readiness.length - 8} more`}</li>}
            </ul>
          </div>
        )}
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        {flags.canConfirm && (
          <button
            type="button"
            className="btn primary"
            onClick={() => setDialog("confirm")}
            disabled={busy || disabledReason !== null}
            aria-disabled={busy || disabledReason !== null}
            aria-describedby={disabledReason ? reasonId : undefined}
            style={busy || disabledReason !== null ? DISABLED_BUTTON_STYLE : undefined}
            data-testid="confirm-agreement"
          >
            {confirming ? "Confirming…" : "Confirm Agreement"}
          </button>
        )}
        {flags.canActivate && (
          <button type="button" className="btn primary" onClick={() => setDialog("activate")} disabled={busy} aria-disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} data-testid="activate-agreement">
            {activating ? "Activating…" : "Activate Agreement"}
          </button>
        )}
        {agreementRef && confirmed && (
          <Link className="btn" href={`/finance/agreements/${encodeURIComponent(agreementRef)}`}>
            Open Agreement
          </Link>
        )}
      </div>
      {flags.canConfirm && disabledReason && (
        <small id={reasonId} className="muted" style={{ display: "block", marginTop: 8 }}>
          {disabledReason} Resolve them above to enable Confirm Agreement.
        </small>
      )}
      {confirmed && !flags.canActivate && headStatus === "DRAFT" && <p className="foundationnote">This version is confirmed and its terms are frozen. It becomes the Agreement in force once someone with permission activates it.</p>}
      {confirmed && headStatus !== "DRAFT" && <p className="foundationnote">This Agreement is already in force. To change its terms, create a revision from the Agreement page.</p>}

      <DialogShell
        open={dialog === "confirm"}
        title="Confirm this Agreement?"
        onClose={() => closeDialog("confirm")}
        footer={
          <>
            <button type="button" className="btn" disabled={confirming} style={confirming ? DISABLED_BUTTON_STYLE : undefined} onClick={() => closeDialog("confirm")}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={confirming} style={confirming ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void runConfirm()}>
              {confirming ? "Confirming…" : "Confirm Agreement"}
            </button>
          </>
        }
      >
        <p className="detailcopy">Confirming freezes the terms of this version. They cannot be edited afterwards; to change them you create a revision. Confirming does not make the Agreement active.</p>
        <p className="foundationnote">Any unsaved changes are saved first. Nothing is written to the Partner or Vendor record.</p>
        {dialogError && (
          <div className="banner" role="alert">
            <span>{dialogError}</span>
          </div>
        )}
      </DialogShell>

      <DialogShell
        open={dialog === "activate"}
        title="Activate this Agreement?"
        onClose={() => closeDialog("activate")}
        footer={
          <>
            <button type="button" className="btn" disabled={activating} style={activating ? DISABLED_BUTTON_STYLE : undefined} onClick={() => closeDialog("activate")}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={activating} style={activating ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void runActivate()}>
              {activating ? "Activating…" : "Activate Agreement"}
            </button>
          </>
        }
      >
        <p className="detailcopy">Activating makes this confirmed version the Agreement in force. If another version is active, it is replaced and stays readable in the version history.</p>
        {dialogError && (
          <div className="banner" role="alert">
            <span>{dialogError}</span>
          </div>
        )}
      </DialogShell>
    </SectionCard>
  );
}

function GroupCard({ group, onJump }: { group: ReviewGroup; onJump: (anchorId: string) => void }) {
  return (
    <section className="record" style={{ padding: 14, minWidth: 0, ...(group.key === "terms" ? { gridColumn: "1 / -1" } : {}) }} data-review-group={group.key} aria-label={group.title}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h3 style={{ fontSize: 13 }}>{group.title}</h3>
        {group.chip && <StatusChip chip={group.chip} />}
      </div>
      {group.rows.map((row) => (
        <KeyValueRow key={row.label} label={row.label}>
          <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontWeight: 500 }}>
            {row.anchorId ? (
              <button type="button" className="btn ghost" style={{ minHeight: 0, padding: 0, textAlign: "left", whiteSpace: "normal", fontWeight: 500, color: "inherit" }} onClick={() => onJump(row.anchorId!)} aria-label={`${row.label}: ${row.text}. Go to this field.`}>
                {row.text}
              </button>
            ) : (
              row.text
            )}
            {row.chip && <StatusChip chip={row.chip} />}
          </span>
        </KeyValueRow>
      ))}
    </section>
  );
}
