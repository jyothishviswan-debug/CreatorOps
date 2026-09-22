"use client";

// Step 14C.3, IA section 7 "Review": counterparty, scope, extraction status, discrepancy count, KYC readiness,
// commercial terms, targets, effective dates, document-storage state, blockers - one concise summary, on `.record`/`.kv`.
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { Pill } from "@/ui/Badge";

import { storeAgreementDocument } from "../api-client";
import { blockerHeadline } from "../confirm-blockers";
import { activationDocumentGate, describeStoreOutcome, reviewDocumentState, STORING_TEXT, type DocumentNotice } from "../document-view";
import { AGREEMENT_DOCUMENT_LABEL, DISABLED_BUTTON_STYLE, OPEN_AGREEMENT_DOCUMENT_LABEL, fieldLabel, lifecycleDisplayChip, type ChipSpec } from "../format";
import { commercialIssues } from "../agreement-intake-logic/editors/commercial-logic";
import { INTAKE_BUSY, useIntake } from "../agreement-intake-logic/intake-context";
import { buildReadiness, buildReviewGroups, confirmDisabledReason, draftResolver, frozenResolver, type ReviewGroup } from "../agreement-intake-logic/review-summary";

import { SectionCard } from "./SectionCard";

const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 };

type DialogKind = "confirm" | "activate" | null;

export function ReviewSection() {
  const intake = useIntake();
  const { flags, version, agreement, counterparty, fieldModels, localEdits, artifact, extraction, extractionAttached, kyc, preview, unresolvedFields, confirmBlockers, revisionDiff, revisionBaseVersion, agreementRef } = intake;
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const reasonId = useId();
  const activateReasonId = useId();
  const [storing, setStoring] = useState(false);
  const storingRef = useRef(false);
  const [documentNotice, setDocumentNotice] = useState<DocumentNotice | null>(null);

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
  const blockersId = "review-blockers";

  useEffect(() => {
    if (confirmBlockers.length > 0) intake.scrollToAnchor(blockersId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a NEW set of blockers arrives
  }, [confirmBlockers]);

  if (!agreement || !version || !counterparty) return null;

  const busy = intake.isBusy();
  const confirming = intake.isBusy(INTAKE_BUSY.confirm);
  const activating = intake.isBusy(INTAKE_BUSY.activate);
  const headStatus = agreement.head.status;
  const documentState = reviewDocumentState({ confirmed, document: version.document, storing, canManage: flags.canManage });
  const activationGate = activationDocumentGate(confirmed ? version.document : null);
  const activateBlockedText = storing ? STORING_TEXT : activationGate.reason;
  const activateOff = busy || storing || activationGate.blocked;
  const chip: ChipSpec = confirmed ? lifecycleDisplayChip(headStatus, true) : readiness.length > 0 ? { label: `${readiness.length} to resolve`, tone: "orange" } : { label: "Ready to confirm", tone: "default" };

  const closeDialog = (key: "confirm" | "activate") => {
    if (intake.isBusy(key === "confirm" ? INTAKE_BUSY.confirm : INTAKE_BUSY.activate)) return;
    setDialog((current) => (current === key ? null : current));
    setDialogError(null);
  };

  const storeDocument = async (versionNumber: number, docVersion: number) => {
    if (!agreementRef || storingRef.current) return;
    storingRef.current = true;
    setStoring(true);
    setDocumentNotice(null);
    try {
      const result = await storeAgreementDocument(agreementRef, { version: versionNumber, expectedDocVersion: docVersion });
      if (result.ok) {
        setDocumentNotice(describeStoreOutcome(result.data));
        await intake.refreshDetail();
      } else if (!result.aborted) setDocumentNotice({ tone: "error", text: `The Agreement document was not stored. ${result.message}` });
    } finally {
      storingRef.current = false;
      setStoring(false);
    }
  };

  const runConfirm = async () => {
    setDialogError(null);
    const result = await intake.confirmAgreement();
    if (result.ok) {
      setDialog(null);
      const confirmedVersion = result.data.selectedVersion;
      if (confirmedVersion && confirmedVersion.document.canStore && flags.canManage) void storeDocument(confirmedVersion.version, confirmedVersion.docVersion);
    } else if (result.aborted) return;
    else if (result.kind === "not_ready") setDialog(null);
    else setDialogError(result.message);
  };

  const runActivate = async () => {
    setDialogError(null);
    const result = await intake.activateAgreement();
    if (result.ok) setDialog(null);
    else if (!result.aborted) setDialogError(result.kind === "not_ready" && result.blockers && result.blockers.length > 0 ? result.blockers.map((blocker) => blocker.message).join(" ") : result.message);
  };

  return (
    <SectionCard sectionKey="review" title="Review" description="Check the summary, resolve anything left, then confirm. Confirming freezes this version's terms." chip={chip}>
      {flags.isRevision && revisionDiff && (
        <article className="record" style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 13 }}>{`Changes from version ${revisionBaseVersion ?? "the previous one"}`}</b>
          {revisionDiff.length === 0 ? (
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>Nothing differs from the previous confirmed version yet.</p>
          ) : (
            <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              {revisionDiff.map((change) => (
                <div key={change.fieldKey} className="kv">
                  <span>{change.label}</span>
                  <b>
                    {change.beforeText} → {change.afterText}
                  </b>
                </div>
              ))}
            </div>
          )}
        </article>
      )}

      <div style={GRID}>
        {groups.map((group) => (
          <ReviewGroupCard key={group.key} group={group} onJump={(anchorId) => intake.scrollToAnchor(anchorId)} />
        ))}
      </div>

      {documentState && (
        <article className="record" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
            <b style={{ fontSize: 13 }}>{AGREEMENT_DOCUMENT_LABEL}</b>
            <Pill tone={documentState.chip.tone === "default" ? undefined : documentState.chip.tone}>{documentState.chip.label}</Pill>
          </div>
          <p role="status" aria-live="polite" style={{ marginTop: 6, overflowWrap: "anywhere", fontSize: 13 }}>
            {documentState.text}
            {documentState.note ? ` ${documentState.note}` : ""}
            {documentNotice && !storing && documentNotice.tone === "error" ? ` ${documentNotice.text}` : ""}
          </p>
          {documentState.action && (
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" className={documentState.action.kind === "store" ? "btn primary" : "btn"} disabled={busy || storing} style={busy || storing ? DISABLED_BUTTON_STYLE : undefined} onClick={() => version && void storeDocument(version.version, version.docVersion)}>
                {documentState.action.label}
              </button>
            </div>
          )}
          {documentState.phase === "stored" && version.document.link && (
            <div className="actions" style={{ marginTop: 8 }}>
              <a className="btn" href={version.document.link} target="_blank" rel="noopener noreferrer">
                {OPEN_AGREEMENT_DOCUMENT_LABEL}
              </a>
            </div>
          )}
        </article>
      )}

      <div id={blockersId} tabIndex={-1} style={{ marginTop: 14, outline: "none" }}>
        {confirmBlockers.length > 0 && (
          <div className="banner" role="alert" style={{ display: "grid", gap: 8, alignItems: "start" }}>
            <b>{blockerHeadline(confirmBlockers.length)}</b>
            <div style={{ display: "grid", gap: 4 }}>
              {confirmBlockers.map((blocker) => (
                <div key={`${blocker.anchorId}-${blocker.message}`} style={{ fontSize: 13 }}>
                  {blocker.message}{" "}
                  <button type="button" className="btn ghost" style={{ minHeight: 0, padding: 0, textDecoration: "underline" }} onClick={() => intake.goToBlocker(blocker)}>
                    Go to it
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {confirmBlockers.length === 0 && readiness.length > 0 && (
          <div className="scopebox">
            <b>{disabledReason}</b>
            <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
              {readiness.slice(0, 8).map((item) => (
                <div key={`${item.anchorId}-${item.message}`} style={{ fontSize: 13 }}>
                  {item.message}{" "}
                  <button type="button" className="btn ghost" style={{ minHeight: 0, padding: 0, textDecoration: "underline" }} onClick={() => intake.scrollToAnchor(item.anchorId)}>
                    Go to it
                  </button>
                </div>
              ))}
              {readiness.length > 8 && <small className="muted">{`+${readiness.length - 8} more`}</small>}
            </div>
          </div>
        )}
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        {flags.canConfirm && (
          <button type="button" className="btn primary" onClick={() => setDialog("confirm")} disabled={busy || disabledReason !== null} aria-describedby={disabledReason ? reasonId : undefined} style={busy || disabledReason !== null ? DISABLED_BUTTON_STYLE : undefined}>
            {confirming ? "Confirming…" : "Confirm Agreement"}
          </button>
        )}
        {flags.canActivate && (
          <button type="button" className="btn primary" onClick={() => setDialog("activate")} disabled={activateOff} aria-describedby={activateBlockedText ? activateReasonId : undefined} style={activateOff ? DISABLED_BUTTON_STYLE : undefined}>
            {activating ? "Activating…" : "Activate Agreement"}
          </button>
        )}
        {agreementRef && confirmed && (
          <Link className="btn" href={`/finance/agreements/${encodeURIComponent(agreementRef)}`}>
            Open Agreement
          </Link>
        )}
      </div>
      {flags.canActivate && activateBlockedText && (
        <small id={activateReasonId} className="muted" style={{ display: "block", marginTop: 8 }}>
          {activateBlockedText}
        </small>
      )}
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
            <button type="button" className="btn ghost" disabled={confirming} style={confirming ? DISABLED_BUTTON_STYLE : undefined} onClick={() => closeDialog("confirm")}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={confirming} style={confirming ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void runConfirm()}>
              {confirming ? "Confirming…" : "Confirm Agreement"}
            </button>
          </>
        }
      >
        <p className="detailcopy">Confirming freezes the terms of this version. They cannot be edited afterwards - to change them, create a revision. Confirming does not make the Agreement active.</p>
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
            <button type="button" className="btn ghost" disabled={activating} style={activating ? DISABLED_BUTTON_STYLE : undefined} onClick={() => closeDialog("activate")}>
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

function ReviewGroupCard({ group, onJump }: { group: ReviewGroup; onJump: (anchorId: string) => void }) {
  return (
    <article className="record" style={group.key === "terms" ? { gridColumn: "1 / -1" } : undefined}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>{group.title}</b>
        {group.chip && <Pill tone={group.chip.tone === "default" ? undefined : group.chip.tone}>{group.chip.label}</Pill>}
      </div>
      <div>
        {group.rows.map((row) => (
          <div className="kv" key={row.label}>
            <span>{row.label}</span>
            <b>
              {row.anchorId ? (
                <button type="button" className="btn ghost" style={{ minHeight: 0, padding: 0, textDecoration: "underline", fontWeight: 500, color: "inherit" }} onClick={() => onJump(row.anchorId!)}>
                  {row.text}
                </button>
              ) : (
                row.text
              )}
              {row.chip && (
                <>
                  {" "}
                  <Pill tone={row.chip.tone === "default" ? undefined : row.chip.tone}>{row.chip.label}</Pill>
                </>
              )}
            </b>
          </div>
        ))}
      </div>
    </article>
  );
}
