"use client";

// FINAL_BUILD_PROMPT Section 8/10: one registry field, rendered as a real, pre-filled form control - not a
// decision card gated behind "Enter value". The proposed/current value sits directly in the control
// (useFieldEditor already opens with it); typing debounce-buffers a CORRECTED edit, leaving it untouched buffers
// nothing by itself, so TermsTargetsStep pre-buffers every untouched-but-valued PENDING field as ACCEPTED before
// this renders (see acceptPrefilledFields in TermsTargetsStep.tsx) - the same buffering pipeline saveDraft/
// confirmAgreement already flush, just triggered without a per-field click. Nothing here writes to the server;
// only Save Draft / Confirm Agreement do (via flushBuffered), matching useFieldEditor's own contract.
import { useState } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { blankLfcSfcRow, blankObligation, blankSlab, blankTarget } from "../agreement-intake-logic/editors/editor-state";
import { MONEY_EDITORS } from "../agreement-intake-logic/editors/editor-state";
import { buildFieldRowView, requiredTextOf } from "../agreement-intake-logic/editors/field-row-view";
import { useFieldEditor } from "../agreement-intake-logic/editors/use-field-editor";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { editorKindFor, type FieldEditorKind, type FieldViewModel } from "../field-view-model";
import { NEEDS_MAPPING_LABEL } from "../format";

import styles from "./AgreementCreatePage.module.css";

const MONEY_QUESTIONS: Partial<Record<AgreementFieldKey, string>> = {
  fixedComponent: "Is there a fixed component?",
  accountTransferFee: "Is there an account transfer fee?",
  advancePayment: "Is there an advance payment?",
};

export function FieldEditRow({ fieldKey }: { fieldKey: AgreementFieldKey }) {
  const { getField, localEdits, version } = useIntake();
  const model = getField(fieldKey);
  if (!model) return null;

  const pending = localEdits[fieldKey];
  const row = buildFieldRowView({ model, pending, currency: version?.terms?.commercial.currency ?? null });
  const kind = editorKindFor(fieldKey);
  const canOptOut = model.requiredForConfirm !== "always";

  return (
    <div className="record" style={{ marginBottom: 10 }} id={`field-${fieldKey}`}>
      <FieldHeader model={model} row={row} pendingDecision={pending?.decision ?? null} />
      {row.needsMapping && (
        <small style={{ display: "block", margin: "6px 0", color: "var(--orange)" }}>
          {NEEDS_MAPPING_LABEL}
          {row.extractedWording ? `: "${row.extractedWording}"` : ""}
        </small>
      )}
      <div style={{ marginTop: 8 }}>
        {MONEY_EDITORS.has(kind) || kind === "incentive" ? (
          <ApplicableGatedEditor fieldKey={fieldKey} kind={kind} model={model} canOptOut={canOptOut} />
        ) : kind === "boolean" ? (
          <BooleanEditor fieldKey={fieldKey} model={model} canOptOut={canOptOut} />
        ) : (
          <ValueEditor fieldKey={fieldKey} kind={kind} model={model} canOptOut={canOptOut} />
        )}
      </div>
    </div>
  );
}

function FieldHeader({ model, row, pendingDecision }: { model: FieldViewModel; row: ReturnType<typeof buildFieldRowView>; pendingDecision: "ACCEPTED" | "CORRECTED" | "NOT_APPLICABLE" | "UNAVAILABLE" | null }) {
  // A field left exactly as proposed (buffered ACCEPTED by acceptPrefilledFields, never touched) shows no chip -
  // it has a value and needs nothing further; the server's still-PENDING decision would otherwise print a stale
  // "Needs confirmation" next to a value that already sits, filled in, in the control. A field the person
  // actually changed, or explicitly opted out of, still shows its real state.
  const showChip = pendingDecision === "CORRECTED" || pendingDecision === "NOT_APPLICABLE" || pendingDecision === "UNAVAILABLE" || (pendingDecision === null && (model.decision === "CORRECTED" || model.decision === "NOT_APPLICABLE" || model.decision === "UNAVAILABLE"));
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
      <div>
        <b>{row.label}</b>
        {row.requiredText && (
          <small className="muted" style={{ marginLeft: 6 }}>
            {row.requiredText}
          </small>
        )}
      </div>
      {showChip ? <span className={`pill${row.statusChip.tone === "default" ? "" : ` ${row.statusChip.tone}`}`}>{row.statusChip.label}</span> : null}
    </div>
  );
}

// Two small text-link fallbacks, next to the control rather than a big button row - used by every editor kind
// that may opt out of a value at all (requiredForConfirm !== "always").
function OptOutLinks({ fieldKey, canOptOut }: { fieldKey: AgreementFieldKey; canOptOut: boolean }) {
  const { setLocalEdit, decideField, isBusy } = useIntake();
  if (!canOptOut) return null;
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
      <button type="button" className="btn ghost" style={{ padding: "2px 0", minHeight: 0 }} disabled={isBusy()} onClick={() => setLocalEdit(fieldKey, undefined, "NOT_APPLICABLE")}>
        Not applicable
      </button>
      <button type="button" className="btn ghost" style={{ padding: "2px 0", minHeight: 0 }} disabled={isBusy()} onClick={() => void decideField({ fieldKey, decision: "UNAVAILABLE" })}>
        Unavailable
      </button>
    </div>
  );
}

// --- Boolean: a Yes/No radio pair (role="radiogroup", styled as .btn - the same pattern already used for a
// binary business decision elsewhere in the app), always visible and pre-selected from the current value. ------
function BooleanEditor({ fieldKey, model, canOptOut }: { fieldKey: AgreementFieldKey; model: FieldViewModel; canOptOut: boolean }) {
  const handle = useFieldEditor({ fieldKey, kind: "boolean" });
  const { state, update } = handle;
  const value = state.kind === "boolean" ? state.value : null;
  const name = `bool-${fieldKey}`;
  return (
    <div>
      <div className={styles.radioRow} role="radiogroup" aria-label={model.label}>
        {([true, false] as const).map((option) => (
          <label key={String(option)} className={styles.radioOption}>
            <input type="radio" name={name} checked={value === option} onChange={() => update({ kind: "boolean", value: option }, true)} />
            {option ? "Yes" : "No"}
          </label>
        ))}
      </div>
      <OptOutLinks fieldKey={fieldKey} canOptOut={canOptOut} />
    </div>
  );
}

// --- Money (fixedComponent / accountTransferFee / advancePayment) and incentive: gated behind its own
// "Is there an amount / incentive?" Yes/No, matching Section 8's Incentive question exactly and reusing the same
// pattern for the three money fields - only rendering the value form once the answer is Yes. -------------------
function ApplicableGatedEditor({ fieldKey, kind, model, canOptOut }: { fieldKey: AgreementFieldKey; kind: FieldEditorKind; model: FieldViewModel; canOptOut: boolean }) {
  const { setLocalEdit, localEdits, isBusy } = useIntake();
  const pending = localEdits[fieldKey];
  const decision = pending?.decision ?? model.decision;
  // "No" so far only if a decision explicitly says NOT_APPLICABLE; anything else (including no decision yet, a
  // proposed value, or a corrected value) reads as "Yes" so the value form is what a person sees by default.
  const [answer, setAnswer] = useState<boolean>(decision !== "NOT_APPLICABLE");
  const name = `applicable-${fieldKey}`;
  const question = kind === "incentive" ? "Is there an incentive?" : MONEY_QUESTIONS[fieldKey as keyof typeof MONEY_QUESTIONS] || `Is there a ${model.label.toLowerCase()}?`;

  return (
    <div>
      <p style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>{question}</p>
      <div className={styles.radioRow} role="radiogroup" aria-label={question}>
        {([true, false] as const).map((option) => (
          <label key={String(option)} className={styles.radioOption}>
            <input
              type="radio"
              name={name}
              checked={answer === option}
              disabled={isBusy()}
              onChange={() => {
                setAnswer(option);
                if (!option) setLocalEdit(fieldKey, undefined, "NOT_APPLICABLE");
              }}
            />
            {option ? "Yes" : "No"}
          </label>
        ))}
      </div>
      {!answer && <small className="muted" style={{ display: "block", marginTop: 6 }}>Not applicable</small>}
      {answer && <div style={{ marginTop: 10 }}>{kind === "incentive" ? <IncentiveEditor fieldKey={fieldKey} /> : <MoneyEditor fieldKey={fieldKey} />}</div>}
      {canOptOut && !answer ? null : <OptOutLinksExceptNotApplicable fieldKey={fieldKey} canOptOut={canOptOut} />}
    </div>
  );
}

// Same as OptOutLinks but without "Not applicable" (the Yes/No question above already covers it).
function OptOutLinksExceptNotApplicable({ fieldKey, canOptOut }: { fieldKey: AgreementFieldKey; canOptOut: boolean }) {
  const { decideField, isBusy } = useIntake();
  if (!canOptOut) return null;
  return (
    <button type="button" className="btn ghost" style={{ padding: "2px 0", minHeight: 0, marginTop: 6 }} disabled={isBusy()} onClick={() => void decideField({ fieldKey, decision: "UNAVAILABLE" })}>
      Unavailable
    </button>
  );
}

function MoneyEditor({ fieldKey }: { fieldKey: AgreementFieldKey }) {
  const kind = editorKindFor(fieldKey);
  const handle = useFieldEditor({ fieldKey, kind });
  const { state, update } = handle;
  if (state.kind !== "money") return null;
  return (
    <div className="grid">
      <div className="s6 field">
        <label>Amount (₹)</label>
        <input value={state.draft.amountText} onChange={(e) => update({ kind: "money", draft: { ...state.draft, amountText: e.target.value, applicable: true } })} />
      </div>
      <div className="s6 field">
        <label>Details</label>
        <input value={state.draft.details ?? ""} onChange={(e) => update({ kind: "money", draft: { ...state.draft, details: e.target.value, applicable: true } })} />
      </div>
    </div>
  );
}

function IncentiveEditor({ fieldKey }: { fieldKey: AgreementFieldKey }) {
  const handle = useFieldEditor({ fieldKey, kind: "incentive" });
  const { state, update } = handle;
  if (state.kind !== "incentive") return null;
  return (
    <div>
      <div className="field">
        <label>Narrative (discretionary incentive language)</label>
        <textarea value={state.narrativeText} onChange={(e) => update({ kind: "incentive", narrativeText: e.target.value, slabs: state.slabs })} style={{ width: "100%" }} />
      </div>
      {state.slabs.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Lower</th>
              <th>Upper</th>
              <th>Unit</th>
              <th>Amount (₹)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.slabs.map((slab, i) => (
              <tr key={i}>
                <td><input value={slab.metricId} onChange={(e) => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: state.slabs.map((s, j) => (j === i ? { ...s, metricId: e.target.value } : s)) })} /></td>
                <td><input value={slab.lowerBoundText} onChange={(e) => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: state.slabs.map((s, j) => (j === i ? { ...s, lowerBoundText: e.target.value } : s)) })} /></td>
                <td><input value={slab.upperBoundText} onChange={(e) => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: state.slabs.map((s, j) => (j === i ? { ...s, upperBoundText: e.target.value } : s)) })} /></td>
                <td><input value={slab.unit} onChange={(e) => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: state.slabs.map((s, j) => (j === i ? { ...s, unit: e.target.value } : s)) })} /></td>
                <td><input value={slab.amountText} onChange={(e) => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: state.slabs.map((s, j) => (j === i ? { ...s, amountText: e.target.value } : s)) })} /></td>
                <td>
                  <button type="button" className="btn ghost" onClick={() => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: state.slabs.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: [...state.slabs, blankSlab()] })}>
        Add slab
      </button>
    </div>
  );
}

// --- Every other editor kind: a plain, always-visible, pre-filled control - text/longText/date/currency/
// paymentCycle/count/qualifyingUnit/platforms as an input/select, and the three structured kinds (lfcSfc,
// performanceTargets, contentObligations) as an always-shown, pre-populated table. ------------------------------
function ValueEditor({ fieldKey, kind, model, canOptOut }: { fieldKey: AgreementFieldKey; kind: FieldEditorKind; model: FieldViewModel; canOptOut: boolean }) {
  const handle = useFieldEditor({ fieldKey, kind });
  const { state, update, errors } = handle;

  return (
    <div>
      {state.kind === "text" && kind === "longText" && (
        <div className="field">
          <textarea value={state.text} onChange={(e) => update({ kind: "text", text: e.target.value })} placeholder={model.label} style={{ width: "100%" }} />
        </div>
      )}
      {state.kind === "text" && kind !== "longText" && <input value={state.text} onChange={(e) => update({ kind: "text", text: e.target.value })} placeholder={model.label} />}
      {state.kind === "platforms" && <input value={state.text} onChange={(e) => update({ kind: "platforms", text: e.target.value })} placeholder="instagram, youtube" />}
      {state.kind === "lfcSfc" && <LfcSfcEditor state={state} update={update} />}
      {state.kind === "targets" && <TargetsEditor state={state} update={update} />}
      {state.kind === "obligations" && <ObligationsEditor state={state} update={update} />}
      {errors.length > 0 && (
        <ul style={{ marginTop: 6 }}>
          {errors.map((error, i) => (
            <li key={i} style={{ color: "var(--red)", fontSize: 11 }}>
              {error}
            </li>
          ))}
        </ul>
      )}
      <OptOutLinks fieldKey={fieldKey} canOptOut={canOptOut} />
    </div>
  );
}

function LfcSfcEditor({ state, update }: { state: Extract<ReturnType<typeof useFieldEditor>["state"], { kind: "lfcSfc" }>; update: ReturnType<typeof useFieldEditor>["update"] }) {
  return (
    <div>
      <div className="field">
        <label>Rule reference (optional)</label>
        <input value={state.ruleRef} onChange={(e) => update({ kind: "lfcSfc", ruleRef: e.target.value, rows: state.rows })} />
      </div>
      {state.rows.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Format</th>
              <th>LFC / SFC</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, i) => (
              <tr key={i}>
                <td><input value={row.format} onChange={(e) => update({ kind: "lfcSfc", ruleRef: state.ruleRef, rows: state.rows.map((r, j) => (j === i ? { ...r, format: e.target.value } : r)) })} /></td>
                <td>
                  <select value={row.kind} onChange={(e) => update({ kind: "lfcSfc", ruleRef: state.ruleRef, rows: state.rows.map((r, j) => (j === i ? { ...r, kind: e.target.value as "LFC" | "SFC" } : r)) })}>
                    <option value="LFC">LFC</option>
                    <option value="SFC">SFC</option>
                  </select>
                </td>
                <td>
                  <button type="button" className="btn ghost" onClick={() => update({ kind: "lfcSfc", ruleRef: state.ruleRef, rows: state.rows.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => update({ kind: "lfcSfc", ruleRef: state.ruleRef, rows: [...state.rows, blankLfcSfcRow()] })}>
        Add format
      </button>
    </div>
  );
}

function TargetsEditor({ state, update }: { state: Extract<ReturnType<typeof useFieldEditor>["state"], { kind: "targets" }>; update: ReturnType<typeof useFieldEditor>["update"] }) {
  return (
    <div>
      {state.rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
              <th>Unit</th>
              <th>Period</th>
              <th>Anchor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, i) => (
              <tr key={i}>
                <td><input value={row.metricId} onChange={(e) => update({ kind: "targets", rows: state.rows.map((r, j) => (j === i ? { ...r, metricId: e.target.value } : r)) })} /></td>
                <td><input value={row.targetValueText} onChange={(e) => update({ kind: "targets", rows: state.rows.map((r, j) => (j === i ? { ...r, targetValueText: e.target.value } : r)) })} /></td>
                <td><input value={row.unit} onChange={(e) => update({ kind: "targets", rows: state.rows.map((r, j) => (j === i ? { ...r, unit: e.target.value } : r)) })} /></td>
                <td><input value={row.periodText ?? ""} placeholder="Period not specified" onChange={(e) => update({ kind: "targets", rows: state.rows.map((r, j) => (j === i ? { ...r, periodText: e.target.value } : r)) })} /></td>
                <td><input value={row.anchorText ?? ""} onChange={(e) => update({ kind: "targets", rows: state.rows.map((r, j) => (j === i ? { ...r, anchorText: e.target.value } : r)) })} /></td>
                <td>
                  <button type="button" className="btn ghost" onClick={() => update({ kind: "targets", rows: state.rows.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" className="btn" onClick={() => update({ kind: "targets", rows: [...state.rows, blankTarget()] })}>
          Add target
        </button>
        <small className="muted">Monitoring only · does not affect payment</small>
      </div>
    </div>
  );
}

function ObligationsEditor({ state, update }: { state: Extract<ReturnType<typeof useFieldEditor>["state"], { kind: "obligations" }>; update: ReturnType<typeof useFieldEditor>["update"] }) {
  return (
    <div>
      {state.rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Obligation</th>
              <th>Quantity</th>
              <th>Period</th>
              <th>Operational mapping</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, i) => (
              <tr key={i}>
                <td><input value={row.label} onChange={(e) => update({ kind: "obligations", rows: state.rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)) })} /></td>
                <td><input value={row.quantityText} onChange={(e) => update({ kind: "obligations", rows: state.rows.map((r, j) => (j === i ? { ...r, quantityText: e.target.value } : r)) })} /></td>
                <td><input value={row.periodText ?? ""} onChange={(e) => update({ kind: "obligations", rows: state.rows.map((r, j) => (j === i ? { ...r, periodText: e.target.value } : r)) })} /></td>
                <td>
                  <input
                    value={row.operationalMappingText ?? ""}
                    placeholder={NEEDS_MAPPING_LABEL}
                    onChange={(e) => update({ kind: "obligations", rows: state.rows.map((r, j) => (j === i ? { ...r, operationalMappingText: e.target.value } : r)) })}
                  />
                </td>
                <td>
                  <button type="button" className="btn ghost" onClick={() => update({ kind: "obligations", rows: state.rows.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => update({ kind: "obligations", rows: [...state.rows, blankObligation()] })}>
        Add obligation
      </button>
    </div>
  );
}

export { requiredTextOf };
