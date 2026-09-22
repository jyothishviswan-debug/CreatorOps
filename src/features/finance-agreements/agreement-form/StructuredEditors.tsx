"use client";

// Step 14C.3: the structured editors - money components, incentive slabs, LFC / SFC formats, performance targets.
// Same `.field` / `.fields` markup as every other editor; a repeating group is a list of small bordered items with
// its own "Add …" action, never a table.
import { useId, type CSSProperties } from "react";

import { MAX_INCENTIVE_SLABS, MAX_LFC_SFC_FORMATS, MAX_PERFORMANCE_TARGETS } from "@/server/finance-agreements/terms";
import { Pill } from "@/ui/Badge";

import { TARGET_MONITORING_LABEL, formatMoneyMinor, parseMoneyInputToMinor } from "../format";
import { OTHER_METRIC_OPTION, TARGET_METRICS, defaultUnitForMetric, metricSelectValue, targetMetricLabel } from "../target-metrics";
import { blankLfcSfcRow, blankSlab, blankTarget } from "../agreement-intake-logic/editors/editor-state";

import type { FieldEditorProps } from "./FieldEditor";

const FULL_WIDTH = { width: "100%" } as const;
const ROW_GRID: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, alignItems: "start" };
const ITEM_BOX: CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "grid", gap: 10, minWidth: 0 };
// Common LFC / SFC format names, offered as suggestions only - typing anything else is always accepted.
const LFC_SFC_FORMAT_PRESETS = ["Long-form video", "Short-form video", "Reels", "Shorts", "Long-form audio", "Short-form audio", "Long-form content", "Short-form content"];

function currencyLabel(currency: string | null): string {
  return currency ?? "the decided currency";
}

function RowHeading({ title, removeLabel, disabled, onRemove }: { title: string; removeLabel: string; disabled: boolean; onRemove: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <b style={{ fontSize: 12 }}>{title}</b>
      <button type="button" className="btn ghost" style={{ minHeight: "auto", padding: "2px 6px" }} disabled={disabled} onClick={onRemove} aria-label={removeLabel}>
        Remove
      </button>
    </div>
  );
}

function ErrorList({ id, errors }: { id: string; errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div id={id} role="alert" style={{ display: "grid", gap: 2 }}>
      {errors.map((error) => (
        <small key={error} style={{ color: "var(--red)" }}>
          {error}
        </small>
      ))}
    </div>
  );
}

// --- Money (fixed component, account transfer fee, advance payment) --------------------------------------------------------------
export function MoneyEditor({ label, state, onChange, onBlur, errors, disabled = false, currency }: FieldEditorProps) {
  const base = useId();
  if (state.kind !== "money") return null;
  const { draft } = state;
  const parsed = draft.amountText.trim() ? parseMoneyInputToMinor(draft.amountText) : null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="field">
        <label htmlFor={`${base}-amount`}>{`${label} (in ${currencyLabel(currency)})`}</label>
        <input id={`${base}-amount`} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={draft.amountText} autoComplete="off" onChange={(event) => onChange({ kind: "money", draft: { ...draft, amountText: event.target.value } })} onBlur={onBlur} />
        <small className="muted">{parsed && parsed.ok ? `Recorded as ${formatMoneyMinor(parsed.amountMinor, currency ?? "INR", { alwaysDecimals: true })}.` : "Enter the amount, for example 35000 or 35,000.50."}</small>
      </div>
      <div className="field">
        <label htmlFor={`${base}-details`}>Details (optional)</label>
        <input id={`${base}-details`} type="text" style={FULL_WIDTH} disabled={disabled} value={draft.details} autoComplete="off" onChange={(event) => onChange({ kind: "money", draft: { ...draft, details: event.target.value } })} onBlur={onBlur} />
      </div>
      <ErrorList id={`${base}-errors`} errors={errors} />
    </div>
  );
}

// --- Incentive slabs --------------------------------------------------------------------------------------------------------------------
export function IncentiveEditor({ state, onChange, onBlur, errors, disabled = false, currency }: FieldEditorProps) {
  const base = useId();
  if (state.kind !== "incentive") return null;
  const { slabs } = state;
  const setSlabs = (next: typeof slabs, immediate = false) => onChange({ kind: "incentive", slabs: next }, immediate);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className="detailcopy">Add one slab for each band the Agreement describes.</p>
      {slabs.map((slab, index) => {
        const n = index + 1;
        const id = (part: string) => `${base}-${index}-${part}`;
        return (
          <div key={index} style={ITEM_BOX} role="group" aria-label={`Slab ${n}`}>
            <RowHeading title={`Slab ${n}`} removeLabel={`Remove slab ${n}`} disabled={disabled} onRemove={() => setSlabs(slabs.filter((_, position) => position !== index), true)} />
            <div style={ROW_GRID}>
              <div className="field">
                <label htmlFor={id("metric")}>Metric</label>
                <input id={id("metric")} type="text" style={FULL_WIDTH} disabled={disabled} value={slab.metricId} autoComplete="off" onChange={(event) => setSlabs(slabs.map((item, position) => (position === index ? { ...item, metricId: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("lower")}>Range start</label>
                <input id={id("lower")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={slab.lowerBoundText} autoComplete="off" onChange={(event) => setSlabs(slabs.map((item, position) => (position === index ? { ...item, lowerBoundText: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("upper")}>Range end (blank = unbounded)</label>
                <input id={id("upper")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={slab.upperBoundText} autoComplete="off" onChange={(event) => setSlabs(slabs.map((item, position) => (position === index ? { ...item, upperBoundText: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("unit")}>Unit</label>
                <input id={id("unit")} type="text" style={FULL_WIDTH} disabled={disabled} value={slab.unit} autoComplete="off" onChange={(event) => setSlabs(slabs.map((item, position) => (position === index ? { ...item, unit: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("amount")}>{`Amount (${currencyLabel(currency)})`}</label>
                <input id={id("amount")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={slab.amountText} autoComplete="off" onChange={(event) => setSlabs(slabs.map((item, position) => (position === index ? { ...item, amountText: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field full">
                <label htmlFor={id("description")}>Description (optional)</label>
                <input id={id("description")} type="text" style={FULL_WIDTH} disabled={disabled} value={slab.description} autoComplete="off" onChange={(event) => setSlabs(slabs.map((item, position) => (position === index ? { ...item, description: event.target.value } : item)))} onBlur={onBlur} />
              </div>
            </div>
          </div>
        );
      })}
      <div>
        <button type="button" className="btn" disabled={disabled || slabs.length >= MAX_INCENTIVE_SLABS} onClick={() => setSlabs([...slabs, blankSlab()], true)}>
          Add slab
        </button>
      </div>
      <ErrorList id={`${base}-errors`} errors={errors} />
    </div>
  );
}

// --- LFC / SFC (explicit rules only) --------------------------------------------------------------------------------------------------------------
export function LfcSfcEditor({ state, onChange, onBlur, errors, disabled = false }: FieldEditorProps) {
  const base = useId();
  if (state.kind !== "lfcSfc") return null;
  const { rows, ruleRef } = state;
  const setRows = (next: typeof rows, immediate = false) => onChange({ kind: "lfcSfc", ruleRef, rows: next }, immediate);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className="detailcopy">LFC = Long-Form Content, SFC = Short-Form Content - only when the Agreement states the rule explicitly. Name each format (as the Agreement describes it, or pick a common one below) and whether it counts as LFC or SFC.</p>
      <datalist id={`${base}-format-presets`}>
        {LFC_SFC_FORMAT_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>
      {rows.map((row, index) => {
        const n = index + 1;
        const id = (part: string) => `${base}-${index}-${part}`;
        return (
          <div key={index} style={ITEM_BOX} role="group" aria-label={`Format ${n}`}>
            <RowHeading title={`Format ${n}`} removeLabel={`Remove format ${n}`} disabled={disabled} onRemove={() => setRows(rows.filter((_, position) => position !== index), true)} />
            <div style={ROW_GRID}>
              <div className="field">
                <label htmlFor={id("format")}>Format name</label>
                <input id={id("format")} type="text" list={`${base}-format-presets`} style={FULL_WIDTH} disabled={disabled} value={row.format} autoComplete="off" onChange={(event) => setRows(rows.map((item, position) => (position === index ? { ...item, format: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("kind")}>Counts as</label>
                <select id={id("kind")} style={FULL_WIDTH} disabled={disabled} value={row.kind} onChange={(event) => setRows(rows.map((item, position) => (position === index ? { ...item, kind: event.target.value === "SFC" ? "SFC" : "LFC" } : item)), true)} onBlur={onBlur}>
                  <option value="LFC">LFC</option>
                  <option value="SFC">SFC</option>
                </select>
              </div>
            </div>
          </div>
        );
      })}
      <div>
        <button type="button" className="btn" disabled={disabled || rows.length >= MAX_LFC_SFC_FORMATS} onClick={() => setRows([...rows, blankLfcSfcRow()], true)}>
          Add format
        </button>
      </div>
      <div className="field">
        <label htmlFor={`${base}-ruleRef`}>Rule reference (optional)</label>
        <input id={`${base}-ruleRef`} type="text" style={FULL_WIDTH} disabled={disabled} value={ruleRef} autoComplete="off" onChange={(event) => onChange({ kind: "lfcSfc", ruleRef: event.target.value, rows })} onBlur={onBlur} />
      </div>
      <ErrorList id={`${base}-errors`} errors={errors} />
    </div>
  );
}

// --- Performance targets (monitoring only) -----------------------------------------------------------------------------------------------------------
export function TargetsEditor({ state, onChange, onBlur, errors, disabled = false }: FieldEditorProps) {
  const base = useId();
  if (state.kind !== "targets") return null;
  const { rows } = state;
  const setRows = (next: typeof rows, immediate = false) => onChange({ kind: "targets", rows: next }, immediate);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className="detailcopy">Each target is a minimum to reach. It is recorded for monitoring only - it never affects any amount owed.</p>
      {rows.map((row, index) => {
        const n = index + 1;
        const id = (part: string) => `${base}-${index}-${part}`;
        const known = metricSelectValue(row.metricId, false);
        const isOther = known === OTHER_METRIC_OPTION || (row.metricId.trim().length > 0 && !TARGET_METRICS.some((metric) => metric.id === row.metricId));
        return (
          <div key={index} style={ITEM_BOX} role="group" aria-label={`Target ${n}`}>
            <RowHeading title={`Target ${n}`} removeLabel={`Remove target ${n}`} disabled={disabled} onRemove={() => setRows(rows.filter((_, position) => position !== index), true)} />
            <div style={ROW_GRID}>
              <div className="field">
                <label htmlFor={id("metric")}>Metric</label>
                <select
                  id={id("metric")}
                  style={FULL_WIDTH}
                  disabled={disabled}
                  value={known}
                  onChange={(event) => {
                    const value = event.target.value;
                    const metricId = value === OTHER_METRIC_OPTION ? "" : value;
                    setRows(rows.map((item, position) => (position === index ? { ...item, metricId, unit: value === OTHER_METRIC_OPTION ? item.unit : defaultUnitForMetric(metricId) } : item)), true);
                  }}
                  onBlur={onBlur}
                >
                  <option value="">Choose a metric…</option>
                  {TARGET_METRICS.map((metric) => (
                    <option key={metric.id} value={metric.id}>
                      {metric.label}
                    </option>
                  ))}
                  <option value={OTHER_METRIC_OPTION}>Other metric</option>
                </select>
                {isOther && <input type="text" style={{ ...FULL_WIDTH, marginTop: 6 }} placeholder="Analytics metric id" disabled={disabled} value={row.metricId} autoComplete="off" onChange={(event) => setRows(rows.map((item, position) => (position === index ? { ...item, metricId: event.target.value } : item)))} onBlur={onBlur} />}
              </div>
              <div className="field">
                <label htmlFor={id("value")}>Minimum value</label>
                <input id={id("value")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={row.targetValueText} autoComplete="off" onChange={(event) => setRows(rows.map((item, position) => (position === index ? { ...item, targetValueText: event.target.value } : item)))} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("unit")}>Unit</label>
                <input id={id("unit")} type="text" style={FULL_WIDTH} disabled={disabled} value={row.unit} autoComplete="off" onChange={(event) => setRows(rows.map((item, position) => (position === index ? { ...item, unit: event.target.value } : item)))} onBlur={onBlur} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Pill tone="gray">{TARGET_MONITORING_LABEL}</Pill>
              {/* The registry captures no time period for a target; a real one is never invented from contract wording. */}
              <small className="muted">Period not specified</small>
              {row.metricId && (
                <small className="muted">
                  {targetMetricLabel(row.metricId)}
                </small>
              )}
            </div>
          </div>
        );
      })}
      <div>
        <button type="button" className="btn" disabled={disabled || rows.length >= MAX_PERFORMANCE_TARGETS} onClick={() => setRows([...rows, blankTarget()], true)}>
          Add target
        </button>
      </div>
      <ErrorList id={`${base}-errors`} errors={errors} />
    </div>
  );
}

export function MonitoringOnly() {
  return <Pill tone="gray">{TARGET_MONITORING_LABEL}</Pill>;
}
