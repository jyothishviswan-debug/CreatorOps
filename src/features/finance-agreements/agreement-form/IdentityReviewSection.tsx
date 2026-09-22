"use client";

// Step 14C.3, IA section 3 "Identity review" (existing counterparty only - a new counterparty is reviewed inside
// NewPartyOnboarding instead). CreatorOps master data is shown for reference (`.kv` rows), then each comparable field as
// one `.record` card - CreatorOps value / Agreement value / status / decision - never a table. Same pure logic as before
// (existing-details-logic.ts, cross-verification.ts, cross-verification-ui.ts), only the layout is new.
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { AGREEMENT_FIELD_BY_KEY } from "@/server/finance-agreements/fields";
import { Pill } from "@/ui/Badge";

import { MaskedValue } from "../components/MaskedValue";
import { fieldAnchorId } from "../confirm-blockers";
import { buildCrossVerificationRows, type CrossVerificationAction, type CrossVerificationRow } from "../cross-verification";
import { accountRows, contactRows, gstinStatusChip, kycRows, overallKycChip } from "../agreement-intake-logic/existing-details-logic";
import { correctedValueSeed, groupCrossVerificationRows, jumpLabel, summarizeCrossVerification, summaryText, validateCorrectedText } from "../agreement-intake-logic/cross-verification-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { DISABLED_BUTTON_STYLE, MASTER_DATA_SOURCE_LABEL, MASTER_DATA_SOURCE_NOTE } from "../format";

import { MasterDataDialog } from "./MasterDataDialog";
import { SectionCard } from "./SectionCard";

const RECORD_GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(235px, 1fr))", gap: 14 };
const PAIR: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };

type PendingDialog = { fieldKey: CrossVerificationRow["fieldKey"]; kind: CrossVerificationAction["kind"] } | null;

export function IdentityReviewSection() {
  const intake = useIntake();
  const { preview, previewLoad, counterparty, reconciliation, flags, hasDraft, agreementRef, refreshReconciliation, scrollToAnchor } = intake;
  const [dialog, setDialog] = useState<PendingDialog>(null);
  const [editing, setEditing] = useState<CrossVerificationRow["fieldKey"] | null>(null);
  const [load, setLoad] = useState<{ status: "idle" | "loading" | "error"; message?: string }>({ status: "idle" });
  const requestedFor = useRef<string | null>(null);

  const rows = useMemo(() => (reconciliation ? buildCrossVerificationRows(reconciliation, { canManage: flags.canManage }) : []), [reconciliation, flags.canManage]);
  const groups = useMemo(() => groupCrossVerificationRows(rows), [rows]);
  const summary = useMemo(() => summarizeCrossVerification(rows), [rows]);

  useEffect(() => {
    if (!hasDraft || !agreementRef || reconciliation || requestedFor.current === agreementRef) return;
    requestedFor.current = agreementRef;
    setLoad({ status: "loading" });
    void refreshReconciliation().then((result) => setLoad(result.ok || result.aborted ? { status: "idle" } : { status: "error", message: result.message }));
  }, [agreementRef, hasDraft, reconciliation, refreshReconciliation]);

  const chip = reconciliation ? (summary.needsResolution > 0 ? { label: `${summary.needsResolution} to resolve`, tone: "orange" as const } : { label: "Resolved", tone: "default" as const }) : { label: MASTER_DATA_SOURCE_LABEL, tone: "blue" as const };
  const dialogRow = dialog ? rows.find((row) => row.fieldKey === dialog.fieldKey) : undefined;
  const dialogAction = dialogRow?.actions.find((action) => action.kind === dialog?.kind);

  return (
    <SectionCard sectionKey="identity" title="Identity review" description="Shown for reference: what CreatorOps already holds, and what the Agreement says. Saving an Agreement never changes the CreatorOps record on its own." chip={chip}>
      {!preview && previewLoad.status === "loading" && <small className="muted">Loading CreatorOps details…</small>}
      {!preview && previewLoad.status === "error" && (
        <div className="banner" role="alert" style={{ margin: 0 }}>
          <span>
            <b>Couldn&rsquo;t load the CreatorOps details.</b> {previewLoad.message}
          </span>
        </div>
      )}
      {!preview && previewLoad.status === "idle" && <p className="foundationnote">{counterparty ? "CreatorOps master data is not shown for your access." : "Choose a Partner or Vendor above to see what CreatorOps already holds for them."}</p>}
      {preview && <ExistingSummary preview={preview} />}

      {reconciliation && (
        <>
          <div style={{ display: "grid", gap: 8, margin: "18px 0 12px" }}>
            <small>{summaryText(summary)}</small>
            {summary.pendingRows.length > 0 && (
              <nav aria-label="Fields that need a decision" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {summary.pendingRows.slice(0, 8).map((row) => (
                  <button key={row.fieldKey} type="button" className="btn ghost" style={{ minHeight: 26, padding: "2px 8px", textDecoration: "underline" }} onClick={() => scrollToAnchor(fieldAnchorId(row.fieldKey))}>
                    {jumpLabel(row)}
                  </button>
                ))}
              </nav>
            )}
          </div>
          {groups.map((group) => (
            <div key={group.key} style={{ marginTop: 14 }}>
              <h3 style={{ fontSize: 13 }}>{group.title}</h3>
              <small className="muted" style={{ display: "block", marginBottom: 8 }}>
                {group.description}
              </small>
              <div style={RECORD_GRID}>
                {group.rows.map((row) => (
                  <RowCard key={row.fieldKey} row={row} editing={editing} setEditing={setEditing} openDialog={(r, action) => setDialog({ fieldKey: r.fieldKey, kind: action.kind })} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {!reconciliation && load.status === "loading" && <small className="muted">Comparing CreatorOps details with the Agreement…</small>}
      {!reconciliation && load.status === "error" && (
        <div className="banner" role="alert">
          <span>{load.message}</span>
        </div>
      )}

      {dialogRow && dialogAction && <MasterDataDialog key={`${dialogRow.fieldKey}:${dialogAction.kind}`} row={dialogRow} action={dialogAction} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}

function ExistingSummary({ preview }: { preview: NonNullable<ReturnType<typeof useIntake>["preview"]> }) {
  const contact = contactRows(preview);
  const accounts = accountRows(preview);
  const kyc = kycRows(preview);
  const gstin = gstinStatusChip(preview.gstinStatus);
  return (
    <div>
      {contact.map((row) => (
        <div className="kv" key={row.key}>
          <span>{row.label}</span>
          <b className={row.muted ? "muted" : undefined}>{row.value}</b>
        </div>
      ))}
      <div className="kv">
        <span>GSTIN</span>
        <b>{gstin.label}</b>
      </div>
      {preview.type === "PARTNER" && accounts.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 12 }}>Partner Accounts</b>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
            {accounts.map((account) => (
              <Pill key={account.key} tone="gray">
                {account.platform} · {account.title}
                {account.inactive ? " · Inactive" : ""}
              </Pill>
            ))}
          </div>
        </div>
      )}
      <div className="kv">
        <span>KYC status</span>
        <b>
          {overallKycChip(preview).label} · {kyc.map((row) => `${row.label}: ${row.chip.label}`).join(", ")}
        </b>
      </div>
    </div>
  );
}

function RowCard({ row, editing, setEditing, openDialog }: { row: CrossVerificationRow; editing: CrossVerificationRow["fieldKey"] | null; setEditing: (key: CrossVerificationRow["fieldKey"] | null) => void; openDialog: (row: CrossVerificationRow, action: CrossVerificationAction) => void }) {
  return (
    <article className="record" id={fieldAnchorId(row.fieldKey)} data-state={row.state} style={row.state === "MISMATCH" ? { borderColor: "#e9c9a8", background: "#fffaf4" } : undefined}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>{row.label}</b>
        <Pill tone={row.stateChip.tone === "default" ? undefined : row.stateChip.tone}>{row.stateChip.label}</Pill>
      </div>
      {row.reasonText && (
        <small className="muted" style={{ display: "block", marginBottom: 6 }}>
          {row.reasonText}
        </small>
      )}
      <div style={PAIR}>
        <div className="kv">
          <span>CreatorOps</span>
          <b>{row.restricted ? <MaskedValue restricted /> : row.creatorOpsText}</b>
        </div>
        <div className="kv">
          <span>Agreement</span>
          <b>{row.restricted ? <MaskedValue restricted /> : row.agreementText}</b>
        </div>
      </div>
      <ActionBlock row={row} editing={editing} setEditing={setEditing} openDialog={openDialog} />
    </article>
  );
}

function ActionBlock({ row, editing, setEditing, openDialog }: { row: CrossVerificationRow } & { editing: CrossVerificationRow["fieldKey"] | null; setEditing: (key: CrossVerificationRow["fieldKey"] | null) => void; openDialog: (row: CrossVerificationRow, action: CrossVerificationAction) => void }) {
  const intake = useIntake();
  const busy = intake.isBusy();
  const decided = row.agreementDecision;
  // Commercial terms never offer master-data update - only the fields cross-verification.ts's MASTER_DATA_TARGETS lists (contact/KYC) do.
  const canSkip = intake.flags.canEdit && !row.restricted && row.needsResolution && AGREEMENT_FIELD_BY_KEY[row.fieldKey].requiredForConfirm !== "always";

  const run = (action: CrossVerificationAction) => {
    if (action.masterData) return openDialog(row, action);
    if (action.valueSource === "typed") return setEditing(row.fieldKey);
    setEditing(null);
    void intake.decideField({ fieldKey: row.fieldKey, decision: action.decision!, ...(action.valueSource === "canonical" ? { value: action.value } : {}) });
  };

  const agreementActions = row.actions.filter((action) => !action.masterData);
  const masterActions = row.actions.filter((action) => action.masterData);

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      {(row.confirmedText !== null || decided) && (
        <small style={{ overflowWrap: "anywhere" }}>
          <b>Your decision: </b>
          {row.confirmedText ?? (decided === "NOT_APPLICABLE" ? "Not applicable" : decided === "UNAVAILABLE" ? "Unavailable" : "")}
        </small>
      )}
      {row.sourceNote && <small className="muted">{MASTER_DATA_SOURCE_NOTE}</small>}
      {row.restricted && <small className="muted">You need restricted-detail access to compare this.</small>}
      {agreementActions.length > 0 && (
        <div className="actions" style={{ gap: 10 }} role="group" aria-label={`Choose a value for ${row.label}`}>
          {agreementActions.map((action) => (
            <button key={action.kind} type="button" className={`btn${action.primary ? " primary" : " ghost"}`} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => run(action)}>
              {action.label}
            </button>
          ))}
        </div>
      )}
      {editing === row.fieldKey && <CorrectedValueForm row={row} onDone={() => setEditing(null)} />}
      {masterActions.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <div className="actions" style={{ gap: 10 }}>
            {masterActions.map((action) => (
              <button key={action.kind} type="button" className="btn ghost" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => run(action)}>
                {action.label}
              </button>
            ))}
          </div>
          <small className="muted">Changes the Partner or Vendor record, not just this Agreement.</small>
        </div>
      )}
      {canSkip && (
        <div className="actions" style={{ gap: 14 }}>
          {(["NOT_APPLICABLE", "UNAVAILABLE"] as const).map((decisionKind) => (
            <button key={decisionKind} type="button" className="btn ghost" style={{ minHeight: "auto", padding: 0, textDecoration: "underline", color: "var(--muted)" }} disabled={busy} onClick={() => void intake.decideField({ fieldKey: row.fieldKey, decision: decisionKind })}>
              {decisionKind === "NOT_APPLICABLE" ? "Not applicable" : "Unavailable"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CorrectedValueForm({ row, onDone }: { row: CrossVerificationRow; onDone: () => void }) {
  const intake = useIntake();
  const id = useId();
  const [text, setText] = useState(() => correctedValueSeed(row));
  const [error, setError] = useState<string | null>(null);
  const busy = intake.isBusy();
  const multiline = row.fieldKey === "address";

  const save = async () => {
    const checked = validateCorrectedText(row.fieldKey, text);
    if (!checked.ok) {
      setError(checked.errors.join(" "));
      return;
    }
    setError(null);
    const result = await intake.decideField({ fieldKey: row.fieldKey, decision: "CORRECTED", value: checked.value });
    if (result.ok) onDone();
    else if (!result.aborted) setError(result.message);
  };

  const inputMode = row.fieldKey === "contactNumber" ? "tel" : row.fieldKey === "emailAddress" ? "email" : undefined;
  const common = {
    id: `${id}-input`,
    value: text,
    style: { width: "100%" },
    disabled: busy,
    onChange: (event: { target: { value: string } }) => {
      setText(event.target.value);
      if (error) setError(null);
    },
  } as const;

  return (
    <div className="field" style={{ background: "var(--canvas)", padding: 10, borderRadius: 8 }}>
      <label htmlFor={`${id}-input`}>{`Corrected ${row.label.toLowerCase()}`}</label>
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} type="text" inputMode={inputMode} autoComplete="off" />}
      {row.fieldKey === "platforms" && <small className="muted">Separate with commas, for example instagram, youtube.</small>}
      {error && (
        <small role="alert" style={{ color: "var(--red)" }}>
          {error}
        </small>
      )}
      <div className="actions" style={{ marginTop: 6 }}>
        <button type="button" className="btn primary" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void save()}>
          Use this value
        </button>
        <button type="button" className="btn ghost" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
