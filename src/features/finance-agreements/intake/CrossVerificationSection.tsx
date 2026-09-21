"use client";

// Step 14B intake, section 5 `Cross-verification`: every comparable field as
//   CreatorOps value | Agreement value | Status | Confirmed value / action
// A table on wide screens, stacked cards on narrow ones. Every status is TEXT (Match / Missing in CreatorOps / Missing in Agreement /
// Mismatch / Not applicable / Restricted / Unavailable); only a Mismatch is subtly highlighted. The actions come from the server's
// allowedActions: an Agreement-side choice is a decision on this Agreement; changing the Partner / Vendor record is a SEPARATE
// button behind its own confirmation dialog. Saving the Agreement never writes master data. A restricted row shows no value.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { AGREEMENT_FIELD_BY_KEY } from "@/server/finance-agreements/fields";

import { MaskedValue } from "../components/MaskedValue";
import { StatusChip } from "../components/StatusChip";
import { fieldAnchorId } from "../confirm-blockers";
import { buildCrossVerificationRows, type CrossVerificationAction, type CrossVerificationRow } from "../cross-verification";
import { DISABLED_BUTTON_STYLE, MASTER_DATA_SOURCE_NOTE, decisionChip, type ChipSpec } from "../format";
import { correctedValueSeed, groupCrossVerificationRows, jumpLabel, summarizeCrossVerification, summaryText, validateCorrectedText } from "./cross-verification-ui";
import { useIntake } from "./intake-context";
import { MasterDataDialog } from "./MasterDataDialog";
import { SectionCard } from "./SectionCard";
import { useWideTableLayout } from "./use-media-query";

const CELL: CSSProperties = { whiteSpace: "normal", overflowWrap: "anywhere", verticalAlign: "top", minWidth: 0, padding: "10px 10px" };
// A Mismatch row is only faintly tinted: the status text says "Mismatch" and never relies on this.
const HIGHLIGHT: CSSProperties = { background: "#fffaf4" };
const SELECTED_STYLE: CSSProperties = { background: "#edf7f1", borderColor: "#b9dccb" };
const MAX_JUMP_LINKS = 8;

type PendingDialog = { fieldKey: CrossVerificationRow["fieldKey"]; kind: CrossVerificationAction["kind"] } | null;

export function CrossVerificationSection() {
  const intake = useIntake();
  const { reconciliation, flags, hasDraft, agreementRef, refreshReconciliation, scrollToAnchor } = intake;
  const wide = useWideTableLayout();
  const [load, setLoad] = useState<{ status: "idle" | "loading" | "error"; message?: string }>({ status: "idle" });
  const [dialog, setDialog] = useState<PendingDialog>(null);
  const [editing, setEditing] = useState<CrossVerificationRow["fieldKey"] | null>(null);
  const requestedFor = useRef<string | null>(null);

  const rows = useMemo(() => (reconciliation ? buildCrossVerificationRows(reconciliation, { canManage: flags.canManage }) : []), [reconciliation, flags.canManage]);
  const groups = useMemo(() => groupCrossVerificationRows(rows), [rows]);
  const summary = useMemo(() => summarizeCrossVerification(rows), [rows]);

  const fetchComparison = () => {
    setLoad({ status: "loading" });
    void refreshReconciliation().then((result) => {
      if (result.ok) setLoad({ status: "idle" });
      else if (!result.aborted) setLoad({ status: "error", message: result.message });
      else setLoad({ status: "idle" });
    });
  };

  // The comparison is read once per draft as soon as this section is on screen (a resumed draft may already carry it).
  useEffect(() => {
    if (!hasDraft || !agreementRef || reconciliation || requestedFor.current === agreementRef) return;
    requestedFor.current = agreementRef;
    setLoad({ status: "loading" });
    void refreshReconciliation().then((result) => {
      if (result.ok || result.aborted) setLoad({ status: "idle" });
      else setLoad({ status: "error", message: result.message });
    });
  }, [agreementRef, hasDraft, reconciliation, refreshReconciliation]);

  const chip: ChipSpec | undefined = reconciliation ? (summary.needsResolution > 0 ? { label: `${summary.needsResolution} to resolve`, tone: "orange" } : { label: "Resolved", tone: "default" }) : undefined;
  const dialogRow = dialog ? rows.find((row) => row.fieldKey === dialog.fieldKey) : undefined;
  const dialogAction = dialogRow?.actions.find((action) => action.kind === dialog?.kind);

  const renderRows = (list: CrossVerificationRow[], title: string) => {
    const shared = { editing, setEditing, openDialog: (row: CrossVerificationRow, action: CrossVerificationAction) => setDialog({ fieldKey: row.fieldKey, kind: action.kind }) };
    // `wide === null`: the layout is not known before hydration - a neutral placeholder rather than a guess that would flash and remount.
    if (wide === null) return <div className="skeleton" aria-hidden="true" style={{ width: "70%" }} />;
    return wide ? <RowsTable rows={list} title={title} {...shared} /> : <RowsCards rows={list} {...shared} />;
  };

  return (
    <SectionCard
      sectionKey="cross_verification"
      description="Compare what CreatorOps holds with what the Agreement says. Choose which value the Agreement keeps. Changing the Partner or Vendor record is a separate step."
      chip={chip}
    >
      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <div role="status" aria-live="polite" data-testid="cross-verification-summary">
          {reconciliation ? <span style={{ fontSize: 12 }}>{summaryText(summary)}</span> : load.status === "loading" ? <small className="muted">Comparing CreatorOps details with the Agreement…</small> : null}
        </div>
        {summary.pendingRows.length > 0 && (
          <nav aria-label="Fields that need a decision" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {summary.pendingRows.slice(0, MAX_JUMP_LINKS).map((row) => (
              <button key={row.fieldKey} type="button" className="btn ghost" style={{ minHeight: 28, padding: "2px 8px", textDecoration: "underline" }} onClick={() => scrollToAnchor(fieldAnchorId(row.fieldKey))}>
                {jumpLabel(row)}
              </button>
            ))}
            {summary.pendingRows.length > MAX_JUMP_LINKS && <small className="muted">{`+${summary.pendingRows.length - MAX_JUMP_LINKS} more below`}</small>}
          </nav>
        )}
      </div>

      {!reconciliation && load.status === "loading" && (
        <div>
          <div className="skeleton" style={{ width: "70%" }} />
          <div className="skeleton" style={{ width: "50%" }} />
          <div className="skeleton" style={{ width: "60%" }} />
        </div>
      )}
      {!reconciliation && load.status === "error" && (
        <div className="banner" role="alert" style={{ margin: 0 }}>
          <span style={{ flex: 1 }}>
            <b>Couldn’t load the comparison.</b> {load.message}
          </span>
          <button type="button" className="btn" onClick={fetchComparison} disabled={intake.isBusy()} style={intake.isBusy() ? DISABLED_BUTTON_STYLE : undefined}>
            Try again
          </button>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.key} style={{ marginTop: 14 }} data-testid={`cross-verification-${group.key}`}>
          <h3 style={{ fontSize: 13 }}>{group.title}</h3>
          <small className="muted" style={{ display: "block", marginBottom: 8 }}>
            {group.description}
          </small>
          {renderRows(group.rows, group.title)}
        </div>
      ))}

      {dialogRow && dialogAction && <MasterDataDialog key={`${dialogRow.fieldKey}:${dialogAction.kind}`} row={dialogRow} action={dialogAction} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}

type RowsProps = { rows: CrossVerificationRow[]; editing: CrossVerificationRow["fieldKey"] | null; setEditing: (key: CrossVerificationRow["fieldKey"] | null) => void; openDialog: (row: CrossVerificationRow, action: CrossVerificationAction) => void };

// --- Wide: the four-column table -----------------------------------------------------------------------------------------------------------
function RowsTable({ rows, title, ...actions }: RowsProps & { title: string }) {
  return (
    <div className="tablewrap" style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
      <table className="compact" style={{ tableLayout: "fixed", minWidth: 600 }}>
        <caption className="sr">{`${title}: CreatorOps value, Agreement value, status and confirmed value`}</caption>
        <thead>
          <tr>
            <th scope="col" style={{ padding: "9px 10px", width: "16%" }}>
              Field
            </th>
            <th scope="col" style={{ padding: "9px 10px", width: "19%" }}>
              CreatorOps value
            </th>
            <th scope="col" style={{ padding: "9px 10px", width: "19%" }}>
              Agreement value
            </th>
            <th scope="col" style={{ padding: "9px 10px", width: "14%" }}>
              Status
            </th>
            <th scope="col" style={{ padding: "9px 10px", width: "32%" }}>
              Confirmed value / action
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.fieldKey} id={fieldAnchorId(row.fieldKey)} data-state={row.state} style={row.highlight ? HIGHLIGHT : undefined}>
              <td style={CELL}>
                <b>{row.label}</b>
              </td>
              <td style={CELL}>
                <CreatorOpsValue row={row} />
              </td>
              <td style={CELL}>
                <AgreementValue row={row} />
              </td>
              <td style={CELL}>
                <StatusBlock row={row} />
              </td>
              <td style={CELL}>
                <ActionBlock row={row} {...actions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Narrow: stacked cards -------------------------------------------------------------------------------------------------------------------------
function RowsCards({ rows, ...actions }: RowsProps) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
      {rows.map((row) => (
        <li key={row.fieldKey} id={fieldAnchorId(row.fieldKey)} className="record" data-state={row.state} style={{ padding: 14, minWidth: 0, ...(row.highlight ? HIGHLIGHT : {}) }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <b style={{ fontSize: 12, overflowWrap: "anywhere" }}>{row.label}</b>
            <StatusChip chip={row.stateChip} status={row.state} />
          </div>
          <div className="kv">
            <span>CreatorOps value</span>
            <b style={{ minWidth: 0, overflowWrap: "anywhere", fontWeight: 500 }}>
              <CreatorOpsValue row={row} />
            </b>
          </div>
          <div className="kv">
            <span>Agreement value</span>
            <b style={{ minWidth: 0, overflowWrap: "anywhere", fontWeight: 500 }}>
              <AgreementValue row={row} />
            </b>
          </div>
          {row.reasonText && (
            <div className="kv">
              <span>Status</span>
              <small className="muted">{row.reasonText}</small>
            </div>
          )}
          <div style={{ paddingTop: 10 }}>
            <ActionBlock row={row} {...actions} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// --- Cell contents ----------------------------------------------------------------------------------------------------------------------------------
function CreatorOpsValue({ row }: { row: CrossVerificationRow }) {
  if (row.restricted) return <MaskedValue restricted />;
  return (
    <span style={{ display: "grid", gap: 2 }}>
      <span className={row.creatorOpsText === "—" || row.creatorOpsNote === null ? "muted" : undefined}>{row.creatorOpsText}</span>
      {row.creatorOpsNote && <small className="muted">{row.creatorOpsNote}</small>}
    </span>
  );
}

function AgreementValue({ row }: { row: CrossVerificationRow }) {
  if (row.restricted) return <MaskedValue restricted />;
  return (
    <span style={{ display: "grid", gap: 2 }}>
      <span className={row.agreementText === "—" ? "muted" : undefined}>{row.agreementText}</span>
      {row.agreementNote && <small className="muted">{row.agreementNote}</small>}
    </span>
  );
}

function StatusBlock({ row }: { row: CrossVerificationRow }) {
  return (
    <span style={{ display: "grid", gap: 4, justifyItems: "start" }}>
      <StatusChip chip={row.stateChip} status={row.state} />
      {row.reasonText && <small className="muted">{row.reasonText}</small>}
    </span>
  );
}

// --- The confirmed value and the actions -----------------------------------------------------------------------------------------------------------
function ActionBlock({ row, editing, setEditing, openDialog }: { row: CrossVerificationRow } & Omit<RowsProps, "rows">) {
  const intake = useIntake();
  const busy = intake.isBusy();
  const decided = row.agreementDecision;
  const canSkip = intake.flags.canEdit && !row.restricted && row.needsResolution && AGREEMENT_FIELD_BY_KEY[row.fieldKey].requiredForConfirm !== "always";

  const run = (action: CrossVerificationAction) => {
    if (action.masterData) return openDialog(row, action);
    if (action.valueSource === "typed") return setEditing(row.fieldKey);
    setEditing(null);
    void intake.decideField({ fieldKey: row.fieldKey, decision: action.decision!, ...(action.valueSource === "canonical" ? { value: action.value } : {}) });
  };

  const button = (action: CrossVerificationAction): ReactNode => {
    const selected = action.selected && !action.masterData;
    return (
      <button
        key={action.kind}
        type="button"
        className={`btn${action.primary ? " primary" : ""}`}
        aria-label={`${action.label} for ${row.label}`}
        aria-pressed={action.masterData || action.valueSource === "typed" ? undefined : selected}
        disabled={busy}
        style={busy ? DISABLED_BUTTON_STYLE : selected ? SELECTED_STYLE : undefined}
        onClick={() => run(action)}
      >
        {action.label}
      </button>
    );
  };

  const agreementActions = row.actions.filter((action) => !action.masterData);
  const masterActions = row.actions.filter((action) => action.masterData);

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {(row.confirmedText !== null || decided) && (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {decided && <StatusChip chip={decisionChip(decided)} status={decided} />}
          {row.confirmedText && <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{row.confirmedText}</span>}
        </span>
      )}
      {row.sourceNote && <small className="muted">{MASTER_DATA_SOURCE_NOTE}</small>}
      {row.restricted && <small className="muted">No value is shown. You need access to restricted details to compare this.</small>}
      {agreementActions.length > 0 && (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }} role="group" aria-label={`Choose a value for ${row.label}`}>
          {agreementActions.map(button)}
        </span>
      )}
      {editing === row.fieldKey && <CorrectedValueForm row={row} onDone={() => setEditing(null)} />}
      {masterActions.length > 0 && (
        <span style={{ display: "grid", gap: 4 }}>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{masterActions.map(button)}</span>
          <small className="muted">Changes the Partner or Vendor record, not just this Agreement.</small>
        </span>
      )}
      {canSkip && (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <small className="muted">Or</small>
          {(["NOT_APPLICABLE", "UNAVAILABLE"] as const).map((decision) => (
            <button
              key={decision}
              type="button"
              className="btn ghost"
              disabled={busy}
              style={{ minHeight: 28, padding: "2px 8px", ...(busy ? DISABLED_BUTTON_STYLE : {}) }}
              aria-label={`Mark ${row.label} ${decision === "NOT_APPLICABLE" ? "not applicable" : "unavailable"}`}
              onClick={() => void intake.decideField({ fieldKey: row.fieldKey, decision })}
            >
              {decision === "NOT_APPLICABLE" ? "Not applicable" : "Unavailable"}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

// `Enter corrected value`: the typed value is checked by the server's own rules before it is sent as a CORRECTED decision.
function CorrectedValueForm({ row, onDone }: { row: CrossVerificationRow; onDone: () => void }) {
  const intake = useIntake();
  const id = useId();
  const [text, setText] = useState(() => correctedValueSeed(row));
  const [error, setError] = useState<string | null>(null);
  const busy = intake.isBusy();
  const multiline = row.fieldKey === "address";
  const label = `Corrected ${row.label.toLowerCase()}`;

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

  // Inline validation: a typed value is checked when the person leaves the box (an empty box is not scolded until they try to use it), and a
  // message clears as soon as they edit the text again.
  const checkOnLeave = () => {
    if (text.trim().length === 0) return;
    const checked = validateCorrectedText(row.fieldKey, text);
    setError(checked.ok ? null : checked.errors.join(" "));
  };
  const inputMode = row.fieldKey === "contactNumber" ? "tel" : row.fieldKey === "emailAddress" ? "email" : undefined;
  const common = {
    id: `${id}-input`,
    value: text,
    style: { width: "100%" },
    disabled: busy,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
    onBlur: checkOnLeave,
    onChange: (event: { target: { value: string } }) => {
      setText(event.target.value);
      if (error) setError(null);
    },
  } as const;
  return (
    <div style={{ display: "grid", gap: 8, border: "1px solid var(--line)", borderRadius: 8, padding: 10, background: "#fafbfc" }}>
      <div className="field">
        <label htmlFor={`${id}-input`}>{label}</label>
        {multiline ? <textarea {...common} rows={3} /> : <input {...common} type="text" inputMode={inputMode} autoComplete="off" />}
        {row.fieldKey === "platforms" && <small className="muted">Separate with commas, for example instagram, youtube.</small>}
        {error && (
          <small id={`${id}-error`} role="alert" style={{ color: "var(--red)" }}>
            {error}
          </small>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void save()}>
          Use this value
        </button>
        <button type="button" className="btn" disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
