"use client";

import { useId, type ReactNode } from "react";

import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import type { FieldEditorKind } from "../../field-view-model";
import { PAYMENT_CYCLE_OPTIONS } from "../../format";
import { QUALIFYING_UNIT_SELECT_OPTIONS } from "../../qualifying-unit";

import { splitPlatformText, type FieldEditorState } from "./editor-state";
import { IncentiveEditor, LfcSfcEditor, MoneyEditor, TargetsEditor } from "./StructuredEditors";

// Step 14B (intake): the value editors, one per editor kind. Every editor is raw `.field` markup with a real label bound by
// htmlFor / id (the shared Field component does not bind labels), reports each change through `onChange(next, immediate)`
// (`immediate` for discrete controls: a select), and shows its message under the control with aria-invalid / aria-describedby.
export type FieldEditorProps = {
  fieldKey: AgreementFieldKey;
  kind: FieldEditorKind;
  label: string;
  state: FieldEditorState;
  onChange: (next: FieldEditorState, immediate?: boolean) => void;
  onBlur: () => void;
  // Field-level messages (empty = valid).
  errors: string[];
  disabled?: boolean;
  // The decided currency (money editors label their amounts with it).
  currency: string | null;
};

const ERROR_STYLE = { color: "var(--red)" } as const;
const FULL_WIDTH = { width: "100%" } as const;

const HINTS: Partial<Record<FieldEditorKind, string>> = {
  currency: "A 3-letter code, for example INR.",
  count: "A whole number.",
  platforms: "Separate with commas, for example instagram, youtube.",
  date: "Choose the date on the calendar.",
};

export function FieldEditor(props: FieldEditorProps) {
  const { kind } = props;
  if (kind === "fixedComponent" || kind === "accountTransferFee" || kind === "advancePayment") return <MoneyEditor {...props} />;
  if (kind === "incentive") return <IncentiveEditor {...props} />;
  if (kind === "lfcSfc") return <LfcSfcEditor {...props} />;
  if (kind === "performanceTargets") return <TargetsEditor {...props} />;
  return <SimpleEditor {...props} />;
}

function SimpleEditor({ fieldKey, kind, label, state, onChange, onBlur, errors, disabled = false }: FieldEditorProps) {
  const error = errors.length > 0 ? errors.join(" ") : null;
  const base = useId();
  const inputId = `${base}-input`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const hint = HINTS[kind];
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const common = { id: inputId, disabled, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy, onBlur } as const;

  let control: ReactNode;
  if (state.kind === "boolean") {
    control = (
      <select
        {...common}
        style={FULL_WIDTH}
        value={state.value === null ? "" : state.value ? "yes" : "no"}
        onChange={(event) => onChange({ kind: "boolean", value: event.target.value === "" ? null : event.target.value === "yes" }, true)}
      >
        <option value="">Choose…</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  } else if (state.kind === "platforms") {
    const parts = splitPlatformText(state.text);
    control = (
      <>
        <input {...common} type="text" style={FULL_WIDTH} autoComplete="off" value={state.text} onChange={(event) => onChange({ kind: "platforms", text: event.target.value })} />
        {parts.length > 0 && (
          <span aria-hidden="true" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {parts.map((part, index) => (
              <span key={`${part}-${index}`} className="pill gray">
                {part}
              </span>
            ))}
          </span>
        )}
      </>
    );
  } else if (state.kind === "text") {
    const set = (text: string, immediate = false) => onChange({ kind: "text", text }, immediate);
    if (kind === "longText") {
      control = <textarea {...common} rows={4} style={{ ...FULL_WIDTH, minHeight: 90 }} value={state.text} onChange={(event) => set(event.target.value)} />;
    } else if (kind === "paymentCycle") {
      control = (
        <select {...common} style={FULL_WIDTH} value={state.text} onChange={(event) => set(event.target.value, true)}>
          <option value="">Choose a payment cycle…</option>
          {PAYMENT_CYCLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    } else if (kind === "qualifyingUnit") {
      // ONLY the two supported operational units (no free text); anything else is mapped here, deliberately.
      control = (
        <select {...common} style={FULL_WIDTH} value={state.text} onChange={(event) => set(event.target.value, true)}>
          <option value="">Choose a qualifying unit…</option>
          {QUALIFYING_UNIT_SELECT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    } else if (kind === "date") {
      control = <input {...common} type="date" style={FULL_WIDTH} value={state.text} onChange={(event) => set(event.target.value)} />;
    } else if (kind === "currency") {
      control = <input {...common} type="text" style={{ ...FULL_WIDTH, textTransform: "uppercase" }} maxLength={3} autoCapitalize="characters" autoComplete="off" value={state.text} onChange={(event) => set(event.target.value.toUpperCase())} />;
    } else if (kind === "count") {
      control = <input {...common} type="text" inputMode="numeric" style={FULL_WIDTH} autoComplete="off" value={state.text} onChange={(event) => set(event.target.value)} />;
    } else {
      control = (
        <input
          {...common}
          type="text"
          inputMode={fieldKey === "contactNumber" ? "tel" : fieldKey === "emailAddress" ? "email" : undefined}
          style={FULL_WIDTH}
          autoComplete="off"
          value={state.text}
          onChange={(event) => set(event.target.value)}
          data-field={fieldKey}
        />
      );
    }
  } else {
    control = null;
  }

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {control}
      {hint && (
        <small id={hintId} className="muted">
          {hint}
        </small>
      )}
      {error && (
        <small id={errorId} role="alert" style={ERROR_STYLE}>
          {error}
        </small>
      )}
    </div>
  );
}
