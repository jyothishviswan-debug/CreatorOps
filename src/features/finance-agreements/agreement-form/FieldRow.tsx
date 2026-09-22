"use client";

// Step 14C.3: ONE registry field, built only from the Foundation `.field` archetype (docs/reference/CreatorOps_UI_Golden_Master.html's
// own formPage: label above a single always-editable control, a `<small>` hint below). No table, no Confidence badge (HIGH confidence
// is the ordinary case and says nothing), no "Contract text" toggle on a clean row, no multi-button segment. Not applicable /
// Unavailable are the only things that cannot be "typed" - they stay small text actions, only where the registry allows them.
import type { CSSProperties, ReactNode } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import { Pill } from "@/ui/Badge";

import { fieldAnchorId } from "../confirm-blockers";
import { confirmedFieldValue } from "../field-values";
import { buildExtractionRows } from "../field-view-model";
import { DISABLED_BUTTON_STYLE, humanizeExtractionWarnings } from "../format";
import { resolveField } from "../agreement-intake-logic/editors/commercial-logic";
import { FieldEditor } from "./FieldEditor";
import { hasValueEditor } from "../agreement-intake-logic/editors/editor-state";
import type { FieldEditorKind } from "../field-view-model";
import { buildFieldRowView } from "../agreement-intake-logic/editors/field-row-view";
import { valueLines } from "../agreement-intake-logic/editors/value-lines";
import { useFieldEditor } from "../agreement-intake-logic/editors/use-field-editor";
import { fieldBusyKey, useIntake } from "../agreement-intake-logic/intake-context";

const ROW: CSSProperties = { borderTop: "1px solid #edf0f3", padding: "14px 0", display: "grid", gap: 6, minWidth: 0 };
const NEEDS_CHECK: CSSProperties = { background: "var(--tint)", borderRadius: 8, padding: 12, margin: "0 -12px" };

export type FieldRowProps = {
  fieldKey: AgreementFieldKey;
  hint?: string;
  notes?: readonly string[];
  extraValidate?: (value: unknown) => string | null;
};

export function FieldRow({ fieldKey, hint, notes, extraValidate }: FieldRowProps) {
  const intake = useIntake();
  const { getField, localEdits, flags, revisionDiff, extraction } = intake;
  const model = getField(fieldKey);
  if (!model) return null;
  // The extraction run's own per-field warnings / raw snippet (reused unchanged, never duplicated): a row shows them
  // only when it needs a closer look, and only ever once - never as a separate list of every proposal on its own.
  const evidence = extraction ? buildExtractionRows(extraction).find((row) => row.fieldKey === fieldKey) : undefined;

  const frozenVersion = intake.version?.confirmed ? intake.version : null;
  if (frozenVersion) return <FrozenRow fieldKey={fieldKey} label={model.label} hint={hint} />;

  const pending = localEdits[fieldKey];
  const currencyResolved = resolveField("currency", getField("currency"), localEdits.currency);
  const currency = currencyResolved.state === "value" && typeof currencyResolved.value === "string" ? currencyResolved.value : null;
  const view = buildFieldRowView({ model, pending, currency, changes: revisionDiff });
  const editable = flags.canEdit;
  const decision = pending?.decision ?? model.decision;
  const undecided = decision === null || decision === "PENDING";
  const busy = intake.isBusy();
  const savingThis = intake.isBusy(fieldBusyKey(fieldKey));
  const canSkip = editable && model.requiredForConfirm !== "always";
  const showEditor = editable && hasValueEditor(model.editorKind);
  // A row earns evidence disclosure only when it needs a closer look - a clean row shows just its value.
  const needsCloserLook = view.confidence !== null && view.confidence !== "HIGH";

  return (
    <div id={fieldAnchorId(fieldKey)} style={ROW} data-field-row={fieldKey} aria-busy={savingThis || undefined}>
      <div style={undecided ? NEEDS_CHECK : undefined}>
        {showEditor ? (
          <InlineEditor fieldKey={fieldKey} kind={model.editorKind} label={`${view.label}${view.requiredText ? ` (${view.requiredText})` : ""}`} currency={currency} busy={busy} extraValidate={extraValidate} />
        ) : (
          <div className="field">
            <label>{view.label}</label>
            <p style={{ margin: 0, fontSize: 13 }}>{view.currentLines.join(" ")}</p>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 6 }}>
          {view.sourceText && (
            <small className="muted">
              {view.sourceText}
              {view.origin === "EXTRACTED" && view.page !== null ? ` · page ${view.page}` : ""}
            </small>
          )}
          {needsCloserLook && <Pill tone="orange">Confidence: {view.confidence!.charAt(0)}{view.confidence!.slice(1).toLowerCase()}</Pill>}
          {view.unsaved && <Pill tone="orange">Unsaved</Pill>}
        </div>

        {hint && (
          <small className="muted" style={{ display: "block", marginTop: 2 }}>
            {hint}
          </small>
        )}
        {view.needsMapping && (
          <small style={{ color: "var(--orange)", display: "block", marginTop: 2 }}>
            {view.extractedWording ? `The Agreement says "${view.extractedWording}", which is not a supported unit. ` : ""}Choose one of the options above, or mark it Unavailable.
          </small>
        )}
        {view.agreementProposedLines && (
          <small className="muted" style={{ display: "block", marginTop: 2, overflowWrap: "anywhere" }}>
            {`The Agreement itself said: ${view.agreementProposedLines.join("; ")}`}
          </small>
        )}
        {/* Progressive disclosure: only a row that needs a closer look offers the source text, never every clean row. */}
        {evidence?.snippet && needsCloserLook && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 11, cursor: "pointer" }}>Show the Agreement&apos;s own wording</summary>
            <p className="foundationnote" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
              {evidence.snippet}
            </p>
          </details>
        )}
        {evidence && evidence.warnings.length > 0 && <small style={{ display: "block", marginTop: 2, color: "#80623f" }}>{humanizeExtractionWarnings(evidence.warnings)}</small>}
        {notes && notes.length > 0 && (
          <div role="status" style={{ display: "grid", gap: 3, marginTop: 4 }}>
            {notes.map((note) => (
              <small key={note} style={{ color: "var(--red)" }}>
                {note}
              </small>
            ))}
          </div>
        )}
      </div>

      {canSkip && (
        <div className="actions" style={{ gap: 14 }}>
          <button type="button" className="btn ghost" style={{ minHeight: "auto", padding: 0, textDecoration: "underline", color: decision === "NOT_APPLICABLE" ? "var(--ink)" : "var(--muted)", fontWeight: decision === "NOT_APPLICABLE" ? 650 : 400 }} disabled={busy} onClick={() => void intake.decideField({ fieldKey, decision: "NOT_APPLICABLE" })}>
            {decision === "NOT_APPLICABLE" ? "✓ Not applicable" : "Not applicable"}
          </button>
          <button type="button" className="btn ghost" style={{ minHeight: "auto", padding: 0, textDecoration: "underline", color: decision === "UNAVAILABLE" ? "var(--ink)" : "var(--muted)", fontWeight: decision === "UNAVAILABLE" ? 650 : 400 }} disabled={busy} onClick={() => void intake.decideField({ fieldKey, decision: "UNAVAILABLE" })}>
            {decision === "UNAVAILABLE" ? "✓ Unavailable" : "Unavailable"}
          </button>
        </div>
      )}
      {!canSkip && model.requiredForConfirm === "always" && <small className="muted">Always required, so Not applicable / Unavailable aren&apos;t offered here.</small>}
    </div>
  );
}

function InlineEditor({ fieldKey, kind, label, currency, busy, extraValidate }: { fieldKey: AgreementFieldKey; kind: FieldEditorKind; label: string; currency: string | null; busy: boolean; extraValidate?: (value: unknown) => string | null }) {
  const editor = useFieldEditor({ fieldKey, kind, extraValidate });
  return <FieldEditor fieldKey={fieldKey} kind={kind} label={label} state={editor.state} onChange={editor.update} onBlur={editor.commitNow} errors={editor.errors} disabled={busy} currency={currency} />;
}

function FrozenRow({ fieldKey, label, hint }: { fieldKey: AgreementFieldKey; label: string; hint?: string }) {
  const intake = useIntake();
  const version = intake.version!;
  const provenance = version.fieldProvenance?.[fieldKey] ?? null;
  const value = confirmedFieldValue(fieldKey, version.terms, version.contactSnapshot);
  const decision = provenance?.decision ?? null;
  const lines: string[] = decision === "UNAVAILABLE" ? ["Unavailable"] : decision === "NOT_APPLICABLE" ? ["Not applicable"] : valueLines(fieldKey, value, { currency: version.terms?.commercial.currency ?? null });
  return (
    <div id={fieldAnchorId(fieldKey)} style={ROW} data-field-row={fieldKey}>
      <div className="field">
        <label>{label}</label>
        <p style={{ margin: 0, fontSize: 13 }}>{lines.join(" ")}</p>
      </div>
      {hint && <small className="muted">{hint}</small>}
      {provenance?.origin === "EXTRACTED" && provenance.provenance.page !== null && <small className="muted">{`From Agreement · page ${provenance.provenance.page}`}</small>}
    </div>
  );
}

export function FieldGroupHeading({ children }: { children: ReactNode }) {
  return <h3 style={{ fontSize: 13, margin: "18px 0 2px" }}>{children}</h3>;
}

export const FIELD_ROW_DISABLED_STYLE = DISABLED_BUTTON_STYLE;
