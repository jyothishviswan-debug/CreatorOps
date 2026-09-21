"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";

import { MAX_INCENTIVE_SLABS, MAX_LFC_SFC_FORMATS, MAX_PERFORMANCE_TARGETS } from "@/server/finance-agreements/terms";

import { TARGET_MONITORING_LABEL, formatMoneyMinor, parseMoneyInputToMinor } from "../../format";

import { blankLfcSfcRow, blankSlab, blankTarget } from "./editor-state";
import type { FieldEditorProps } from "./FieldEditors";
import { OTHER_METRIC_OPTION, TARGET_METRICS, defaultUnitForMetric, metricSelectValue } from "./target-metrics";

// Step 14B (intake): the structured editors - money components, incentive slabs, LFC / SFC formats, performance targets.
// Same contract as the simple editors (raw `.field` markup, real labels via htmlFor / id, messages under the control).
const FULL_WIDTH = { width: "100%" } as const;
const ERROR_STYLE = { color: "var(--red)" } as const;
const ROW_GRID: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, alignItems: "start" };
const ITEM_BOX: CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "grid", gap: 10, minWidth: 0 };

function currencyLabel(currency: string | null): string {
  return currency ?? "INR";
}

function ErrorList({ id, errors }: { id: string; errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul id={id} role="alert" style={{ ...ERROR_STYLE, margin: 0, paddingLeft: 18, fontSize: 11, display: "grid", gap: 3 }}>
      {errors.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function RowHeading({ title, onRemove, removeLabel, disabled }: { title: string; onRemove: () => void; removeLabel: string; disabled: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <b style={{ fontSize: 11 }}>{title}</b>
      <button type="button" className="btn ghost" style={{ minHeight: 28, padding: "2px 8px" }} onClick={onRemove} disabled={disabled} aria-label={removeLabel}>
        Remove
      </button>
    </div>
  );
}

// --- Money components (fixed component, account transfer fee, advance) -------------------------------------------------------------------
export function MoneyEditor({ fieldKey, label, state, onChange, onBlur, errors, disabled = false, currency }: FieldEditorProps) {
  const base = useId();
  if (state.kind !== "money") return null;
  const withDetails = fieldKey === "accountTransferFee" || fieldKey === "advancePayment";
  const draft = state.draft;
  const parsed = draft.amountText.trim().length > 0 ? parseMoneyInputToMinor(draft.amountText) : null;
  const update = (patch: Partial<typeof draft>) => onChange({ kind: "money", draft: { ...draft, ...patch } });
  const errorsId = `${base}-errors`;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={ROW_GRID}>
        <div className="field">
          <label htmlFor={`${base}-amount`}>{`${label} amount (${currencyLabel(currency)})`}</label>
          <input
            id={`${base}-amount`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            style={FULL_WIDTH}
            disabled={disabled}
            value={draft.amountText}
            aria-invalid={errors.length > 0 ? true : undefined}
            aria-describedby={[`${base}-amount-hint`, errors.length > 0 ? errorsId : null].filter(Boolean).join(" ")}
            onChange={(event) => update({ amountText: event.target.value })}
            onBlur={onBlur}
          />
          <small id={`${base}-amount-hint`} className="muted">
            {parsed && parsed.ok ? `Recorded as ${formatMoneyMinor(parsed.amountMinor, currencyLabel(currency), { alwaysDecimals: true })}.` : "Enter the amount, for example 35000 or 35,000.50."}
          </small>
        </div>
        {withDetails && (
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor={`${base}-details`}>{`${label} details (optional if an amount is given)`}</label>
            <textarea id={`${base}-details`} rows={2} style={{ ...FULL_WIDTH, minHeight: 60 }} disabled={disabled} value={draft.details ?? ""} onChange={(event) => update({ details: event.target.value })} onBlur={onBlur} />
          </div>
        )}
      </div>
      <ErrorList id={errorsId} errors={errors} />
    </div>
  );
}

// --- Incentive slabs ------------------------------------------------------------------------------------------------------------------------------
export function IncentiveEditor({ state, onChange, onBlur, errors, disabled = false, currency }: FieldEditorProps) {
  const base = useId();
  if (state.kind !== "incentive") return null;
  const slabs = state.slabs;
  const setSlabs = (next: typeof slabs, immediate = false) => onChange({ kind: "incentive", slabs: next }, immediate);
  const patch = (index: number, change: Partial<(typeof slabs)[number]>) => setSlabs(slabs.map((slab, position) => (position === index ? { ...slab, ...change } : slab)));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {slabs.length === 0 && <p className="detailcopy">No slabs yet. Add one slab per band of the incentive the Agreement describes.</p>}
      {slabs.map((slab, index) => {
        const n = index + 1;
        const id = (part: string) => `${base}-${index}-${part}`;
        return (
          <div key={index} style={ITEM_BOX} role="group" aria-label={`Slab ${n}`}>
            <RowHeading title={`Slab ${n}`} removeLabel={`Remove slab ${n}`} disabled={disabled} onRemove={() => setSlabs(slabs.filter((_, position) => position !== index), true)} />
            <div style={ROW_GRID}>
              <div className="field">
                <label htmlFor={id("metric")}>Metric</label>
                <input id={id("metric")} type="text" style={FULL_WIDTH} disabled={disabled} value={slab.metricId} autoComplete="off" onChange={(event) => patch(index, { metricId: event.target.value })} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("lower")}>From (lower bound)</label>
                <input id={id("lower")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={slab.lowerBoundText} autoComplete="off" onChange={(event) => patch(index, { lowerBoundText: event.target.value })} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("upper")}>Up to (upper bound)</label>
                <input id={id("upper")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={slab.upperBoundText} autoComplete="off" onChange={(event) => patch(index, { upperBoundText: event.target.value })} onBlur={onBlur} aria-describedby={id("upper-hint")} />
                <small id={id("upper-hint")} className="muted">
                  Leave blank for no upper limit.
                </small>
              </div>
              <div className="field">
                <label htmlFor={id("unit")}>Unit</label>
                <input id={id("unit")} type="text" style={FULL_WIDTH} disabled={disabled} value={slab.unit} autoComplete="off" onChange={(event) => patch(index, { unit: event.target.value })} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("amount")}>{`Incentive amount (${currencyLabel(currency)})`}</label>
                <input id={id("amount")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={slab.amountText} autoComplete="off" onChange={(event) => patch(index, { amountText: event.target.value })} onBlur={onBlur} />
              </div>
            </div>
            <div className="field">
              <label htmlFor={id("description")}>Description (optional)</label>
              <input id={id("description")} type="text" style={FULL_WIDTH} disabled={disabled} value={slab.description ?? ""} autoComplete="off" onChange={(event) => patch(index, { description: event.target.value })} onBlur={onBlur} />
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
      <p className="detailcopy">Only record LFC / SFC when the Agreement states the rule explicitly. Name each format and whether it counts as LFC or SFC.</p>
      {rows.map((row, index) => {
        const n = index + 1;
        const id = (part: string) => `${base}-${index}-${part}`;
        return (
          <div key={index} style={ITEM_BOX} role="group" aria-label={`Format ${n}`}>
            <RowHeading title={`Format ${n}`} removeLabel={`Remove format ${n}`} disabled={disabled} onRemove={() => setRows(rows.filter((_, position) => position !== index), true)} />
            <div style={ROW_GRID}>
              <div className="field">
                <label htmlFor={id("format")}>Format name</label>
                <input id={id("format")} type="text" style={FULL_WIDTH} disabled={disabled} value={row.format} autoComplete="off" onChange={(event) => setRows(rows.map((item, position) => (position === index ? { ...item, format: event.target.value } : item)))} onBlur={onBlur} />
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
  // Rows whose person picked "Other metric" but has not typed the id yet (so the id box stays open while empty).
  const [otherRows, setOtherRows] = useState<ReadonlySet<number>>(new Set());
  if (state.kind !== "targets") return null;
  const rows = state.rows;
  const setRows = (next: typeof rows, immediate = false) => onChange({ kind: "targets", rows: next }, immediate);
  const patch = (index: number, change: Partial<(typeof rows)[number]>, immediate = false) => setRows(rows.map((row, position) => (position === index ? { ...row, ...change } : row)), immediate);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {rows.length === 0 && <p className="detailcopy">No targets. Add one only if the Agreement sets a target to watch.</p>}
      {rows.map((row, index) => {
        const n = index + 1;
        const id = (part: string) => `${base}-${index}-${part}`;
        const selectValue = metricSelectValue(row.metricId, otherRows.has(index));
        const isOther = selectValue === OTHER_METRIC_OPTION;
        return (
          <div key={index} style={ITEM_BOX} role="group" aria-label={`Target ${n}`}>
            <RowHeading
              title={`Target ${n}`}
              removeLabel={`Remove target ${n}`}
              disabled={disabled}
              onRemove={() => {
                setOtherRows(new Set());
                setRows(rows.filter((_, position) => position !== index), true);
              }}
            />
            <div style={ROW_GRID}>
              <div className="field">
                <label htmlFor={id("metric")}>Metric</label>
                <select
                  id={id("metric")}
                  style={FULL_WIDTH}
                  disabled={disabled}
                  value={selectValue}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    if (chosen === OTHER_METRIC_OPTION) {
                      setOtherRows(new Set(otherRows).add(index));
                      patch(index, { metricId: isOther ? row.metricId : "" }, true);
                    } else {
                      const next = new Set(otherRows);
                      next.delete(index);
                      setOtherRows(next);
                      patch(index, { metricId: chosen, unit: row.unit.trim().length === 0 ? defaultUnitForMetric(chosen) : row.unit }, true);
                    }
                  }}
                  onBlur={onBlur}
                >
                  <option value="">Choose a metric…</option>
                  {TARGET_METRICS.map((metric) => (
                    <option key={metric.id} value={metric.id}>
                      {metric.label}
                    </option>
                  ))}
                  <option value={OTHER_METRIC_OPTION}>Other Analytics metric…</option>
                </select>
              </div>
              {isOther && (
                <div className="field">
                  <label htmlFor={id("metric-id")}>Metric id</label>
                  <input id={id("metric-id")} type="text" style={FULL_WIDTH} disabled={disabled} value={row.metricId} autoComplete="off" onChange={(event) => patch(index, { metricId: event.target.value })} onBlur={onBlur} />
                </div>
              )}
              <div className="field">
                <label htmlFor={id("value")}>At least</label>
                <input id={id("value")} type="text" inputMode="decimal" style={FULL_WIDTH} disabled={disabled} value={row.targetValueText} autoComplete="off" onChange={(event) => patch(index, { targetValueText: event.target.value })} onBlur={onBlur} />
              </div>
              <div className="field">
                <label htmlFor={id("unit")}>Unit</label>
                <input id={id("unit")} type="text" style={FULL_WIDTH} disabled={disabled} value={row.unit} autoComplete="off" onChange={(event) => patch(index, { unit: event.target.value })} onBlur={onBlur} />
              </div>
            </div>
            <MonitoringOnly />
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

// The fixed statement every target carries. There is no toggle anywhere.
export function MonitoringOnly({ children }: { children?: ReactNode }) {
  return (
    <small className="muted" data-testid="target-monitoring-only">
      {TARGET_MONITORING_LABEL}
      {children}
    </small>
  );
}
