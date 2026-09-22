"use client";

// FINAL_EXECUTION: one field's display + inline editor, generic across every DECIDED registry field. Review by
// exception (Section 20): resolved/HIGH-confidence fields render compact; only PENDING/needsMapping fields expand
// their editor by default.
import { useState } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { blankLfcSfcRow, blankObligation, blankSlab, blankTarget } from "../agreement-intake-logic/editors/editor-state";
import { buildFieldRowView } from "../agreement-intake-logic/editors/field-row-view";
import { useFieldEditor } from "../agreement-intake-logic/editors/use-field-editor";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { decisionActionsFor } from "../components";
import { editorKindFor, type FieldViewModel } from "../field-view-model";
import { NEEDS_MAPPING_LABEL } from "../format";

export function FieldRow({ fieldKey }: { fieldKey: AgreementFieldKey }) {
  const { getField, localEdits, decideField, version, isBusy } = useIntake();
  const model = getField(fieldKey);
  const [editing, setEditing] = useState(false);
  if (!model) return null;

  const pending = localEdits[fieldKey];
  const row = buildFieldRowView({ model, pending, currency: version?.terms?.commercial.currency ?? null });
  const actions = decisionActionsFor({ fieldKey, decision: model.decision, origin: model.origin, hasValue: model.hasValue });
  const busy = isBusy(`field:${fieldKey}`);
  const kind = editorKindFor(fieldKey);
  const autoOpen = model.decision === "PENDING" || row.needsMapping;

  return (
    <div className="record" style={{ marginBottom: 10 }} id={`field-${fieldKey}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <b>{row.label}</b>
          {row.requiredText && (
            <small className="muted" style={{ marginLeft: 6 }}>
              {row.requiredText}
            </small>
          )}
        </div>
        <span className={`pill${row.statusChip.tone === "default" ? "" : ` ${row.statusChip.tone}`}`}>{row.statusChip.label}</span>
      </div>
      <div style={{ marginTop: 8 }}>
        {row.currentLines.map((line, i) => (
          <div key={i} style={{ fontSize: 12 }}>
            {line}
          </div>
        ))}
        {row.sourceText && (
          <small className="muted" style={{ display: "block", marginTop: 4 }}>
            {row.sourceText}
            {row.confidence && row.confidence !== "HIGH" ? ` · Confidence: ${row.confidence.charAt(0)}${row.confidence.slice(1).toLowerCase()}` : ""}
          </small>
        )}
        {row.needsMapping && (
          <small style={{ display: "block", marginTop: 4, color: "var(--orange)" }}>
            {NEEDS_MAPPING_LABEL}
            {row.extractedWording ? `: "${row.extractedWording}"` : ""}
          </small>
        )}
      </div>

      {(editing || autoOpen) && (
        <InlineEditor fieldKey={fieldKey} kind={kind} onDone={() => setEditing(false)} model={model} />
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {actions.map((action) =>
          action.kind === "ENTER_VALUE" ? (
            <button key={action.kind} type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              {action.label}
            </button>
          ) : (
            <button
              key={action.kind}
              type="button"
              className={`btn${action.pressed ? " primary" : ""}`}
              disabled={busy}
              onClick={() => void decideField({ fieldKey, decision: action.decision })}
            >
              {action.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

// A separate, always-fully-mounted-or-unmounted child so useFieldEditor (a hook) is never called conditionally
// within FieldRow's own render.
function InlineEditor({ fieldKey, kind, onDone, model }: { fieldKey: AgreementFieldKey; kind: ReturnType<typeof editorKindFor>; onDone: () => void; model: FieldViewModel }) {
  const handle = useFieldEditor({ fieldKey, kind });
  const { state, errors, ready, update, saveNow, discard } = handle;

  const save = async () => {
    const ok = await saveNow();
    if (ok) onDone();
  };

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      {state.kind === "text" && <input value={state.text} onChange={(e) => update({ kind: "text", text: e.target.value })} placeholder={model.label} />}
      {state.kind === "boolean" && (
        <select value={state.value === null ? "" : String(state.value)} onChange={(e) => update({ kind: "boolean", value: e.target.value === "" ? null : e.target.value === "true" }, true)}>
          <option value="">Choose</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )}
      {state.kind === "platforms" && <input value={state.text} onChange={(e) => update({ kind: "platforms", text: e.target.value })} placeholder="instagram, youtube" />}
      {state.kind === "money" && (
        <div className="grid">
          <div className="s6 field">
            <label>Amount (₹)</label>
            <input value={state.draft.amountText} onChange={(e) => update({ kind: "money", draft: { ...state.draft, amountText: e.target.value } })} />
          </div>
          <div className="s6 field">
            <label>Details</label>
            <input value={state.draft.details ?? ""} onChange={(e) => update({ kind: "money", draft: { ...state.draft, details: e.target.value } })} />
          </div>
        </div>
      )}
      {state.kind === "incentive" && (
        <div>
          <div className="field">
            <label>Narrative (discretionary incentive language)</label>
            <textarea value={state.narrativeText} onChange={(e) => update({ kind: "incentive", narrativeText: e.target.value, slabs: state.slabs })} />
          </div>
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
          <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => update({ kind: "incentive", narrativeText: state.narrativeText, slabs: [...state.slabs, blankSlab()] })}>
            Add slab
          </button>
        </div>
      )}
      {state.kind === "lfcSfc" && (
        <div>
          <div className="field">
            <label>Rule reference (optional)</label>
            <input value={state.ruleRef} onChange={(e) => update({ kind: "lfcSfc", ruleRef: e.target.value, rows: state.rows })} />
          </div>
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
          <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => update({ kind: "lfcSfc", ruleRef: state.ruleRef, rows: [...state.rows, blankLfcSfcRow()] })}>
            Add format
          </button>
        </div>
      )}
      {state.kind === "targets" && (
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
            <tr>
              <td colSpan={6}>
                <button type="button" className="btn" onClick={() => update({ kind: "targets", rows: [...state.rows, blankTarget()] })}>
                  Add target
                </button>
                <small className="muted" style={{ marginLeft: 8 }}>
                  Monitoring only · does not affect payment
                </small>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {state.kind === "obligations" && (
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
            <tr>
              <td colSpan={5}>
                <button type="button" className="btn" onClick={() => update({ kind: "obligations", rows: [...state.rows, blankObligation()] })}>
                  Add obligation
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {errors.length > 0 && (
        <ul style={{ marginTop: 8 }}>
          {errors.map((error, i) => (
            <li key={i} style={{ color: "var(--red)", fontSize: 11 }}>
              {error}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" className="btn primary" disabled={!ready} onClick={() => void save()}>
          Save
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            discard();
            onDone();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
