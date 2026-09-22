import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { isSupportedQualifyingUnit, minorToInputText } from "../../format";
import type { FieldEditorKind } from "../../field-view-model";
import {
  TEXT_FIELD_LIMITS,
  buildAccountTransferFee,
  buildAdvancePayment,
  buildContentObligations,
  buildFixedComponent,
  buildIncentive,
  buildLfcSfc,
  buildPerformanceTargets,
  validateCurrency,
  validateDateField,
  validateFieldValue,
  validatePaymentCycle,
  validatePlatforms,
  validateQualifyingCount,
  validateQualifyingUnit,
  validateTextField,
  type ContentObligationDraft,
  type IncentiveSlabDraft,
  type LfcSfcRowDraft,
  type MoneyComponentDraft,
  type PerformanceTargetDraft,
  type TextFieldKey,
  type ValidationResult,
} from "../../terms-validators";

// Step 14B (intake): the local EDIT STATE of every field editor and its conversion to the value a decision carries (pure).
//
// A person types into an editor; the editor keeps a plain-string state (never a half-parsed number); `editorStateToValue`
// turns that state into the exact value the server's own check accepts - by building it with the terms validators (money is
// rupees -> integer minor units, no floats) and running the registry's checkFieldDecisionValue as the final authority.
// `initialEditorState` goes the other way: a stored / proposed value -> the state the editor opens with.

export type FieldEditorState =
  | { kind: "text"; text: string }
  | { kind: "boolean"; value: boolean | null }
  | { kind: "platforms"; text: string }
  | { kind: "money"; draft: MoneyComponentDraft }
  | { kind: "incentive"; narrativeText: string; slabs: IncentiveSlabDraft[] }
  | { kind: "lfcSfc"; ruleRef: string; rows: LfcSfcRowDraft[] }
  | { kind: "targets"; rows: PerformanceTargetDraft[] }
  | { kind: "obligations"; rows: ContentObligationDraft[] };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const numberText = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "");

// The editors that hold a single line / paragraph of text (dates, codes and counts are typed as text too).
export const TEXT_LIKE_EDITORS: ReadonlySet<FieldEditorKind> = new Set<FieldEditorKind>(["text", "longText", "date", "currency", "paymentCycle", "count", "qualifyingUnit"]);
export const MONEY_EDITORS: ReadonlySet<FieldEditorKind> = new Set<FieldEditorKind>(["fixedComponent", "accountTransferFee", "advancePayment"]);

// Does an editor exist that can produce a value for this field? (identity values, computed fields and unknown kinds: no.)
export function hasValueEditor(kind: FieldEditorKind): boolean {
  return TEXT_LIKE_EDITORS.has(kind) || MONEY_EDITORS.has(kind) || kind === "boolean" || kind === "platforms" || kind === "incentive" || kind === "lfcSfc" || kind === "performanceTargets" || kind === "contentObligations";
}

export const blankSlab = (): IncentiveSlabDraft => ({ metricId: "", lowerBoundText: "", upperBoundText: "", unit: "", amountText: "", description: "" });
export const blankLfcSfcRow = (): LfcSfcRowDraft => ({ format: "", kind: "LFC" });
export const blankTarget = (): PerformanceTargetDraft => ({ metricId: "", targetValueText: "", unit: "" });
export { blankObligation } from "../../terms-validators";

// --- value -> editor state -------------------------------------------------------------------------------------------------------------------
function moneyDraftFrom(value: unknown): MoneyComponentDraft {
  const record = isRecord(value) ? value : {};
  return {
    applicable: true,
    amountText: minorToInputText(typeof record.amountMinor === "number" ? record.amountMinor : null),
    details: asText(record.details),
  };
}

export function initialEditorState(fieldKey: AgreementFieldKey, kind: FieldEditorKind, value: unknown): FieldEditorState {
  if (MONEY_EDITORS.has(kind)) return { kind: "money", draft: moneyDraftFrom(value) };
  switch (kind) {
    case "boolean":
      return { kind: "boolean", value: typeof value === "boolean" ? value : null };
    case "platforms":
      return { kind: "platforms", text: Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(", ") : "" };
    case "incentive": {
      const record = isRecord(value) ? value : {};
      const slabs = Array.isArray(record.slabs) ? record.slabs : [];
      return {
        kind: "incentive",
        narrativeText: asText(record.narrative),
        slabs: slabs.filter(isRecord).map((slab) => ({
          slabRef: asText(slab.slabRef),
          metricId: asText(slab.metricId),
          lowerBoundText: numberText(slab.lowerBound),
          upperBoundText: numberText(slab.upperBound),
          unit: asText(slab.unit),
          amountText: minorToInputText(typeof slab.amountMinor === "number" ? slab.amountMinor : null),
          description: asText(slab.description),
        })),
      };
    }
    case "lfcSfc": {
      const record = isRecord(value) ? value : {};
      const byFormat = isRecord(record.byFormat) ? record.byFormat : {};
      return {
        kind: "lfcSfc",
        ruleRef: asText(record.ruleRef),
        rows: Object.entries(byFormat).map(([format, ruleKind]) => ({ format, kind: ruleKind === "SFC" ? "SFC" : "LFC" })),
      };
    }
    case "performanceTargets": {
      const targets = Array.isArray(value) ? value : [];
      return {
        kind: "targets",
        rows: targets.filter(isRecord).map((target) => ({
          targetRef: asText(target.targetRef),
          metricId: asText(target.metricId),
          targetValueText: numberText(target.targetValue),
          unit: asText(target.unit),
          periodText: asText(target.period),
          anchorText: asText(target.anchor),
        })),
      };
    }
    case "contentObligations": {
      const rows = Array.isArray(value) ? value : [];
      return {
        kind: "obligations",
        rows: rows.filter(isRecord).map((row) => ({
          obligationRef: asText(row.obligationRef),
          label: asText(row.label),
          quantityText: numberText(row.quantity),
          periodText: asText(row.period),
          operationalMappingText: asText(row.operationalMapping),
        })),
      };
    }
    case "qualifyingUnit":
      // An unsupported wording ("reel") is NEVER pre-selected: the person maps it deliberately.
      return { kind: "text", text: isSupportedQualifyingUnit(value) ? value : "" };
    default: {
      // text-like
      if (typeof value === "string") return { kind: "text", text: value };
      if (typeof value === "number") return { kind: "text", text: String(value) };
      void fieldKey;
      return { kind: "text", text: "" };
    }
  }
}

// --- editor state -> the value a decision carries --------------------------------------------------------------------------------------------
function textValue(fieldKey: AgreementFieldKey, kind: FieldEditorKind, text: string): ValidationResult<unknown> {
  switch (kind) {
    case "date":
      return validateDateField(text);
    case "currency":
      return validateCurrency(text);
    case "paymentCycle":
      return validatePaymentCycle(text);
    case "count":
      return validateQualifyingCount(text);
    case "qualifyingUnit":
      return validateQualifyingUnit(text);
    default:
      if (fieldKey === "pinCode" || Object.prototype.hasOwnProperty.call(TEXT_FIELD_LIMITS, fieldKey)) return validateTextField(fieldKey as TextFieldKey | "pinCode", text);
      return text.trim().length === 0 ? { ok: false, errors: ["Enter a value, or choose Not applicable / Unavailable."] } : { ok: true, value: text.trim() };
  }
}

// Split a typed platform list ("instagram, YouTube") - commas or line breaks.
export const splitPlatformText = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

// The field's own value from an editor state, validated by the SAME rules the server applies (errors are field-level messages).
export function editorStateToValue(fieldKey: AgreementFieldKey, kind: FieldEditorKind, state: FieldEditorState): ValidationResult<unknown> {
  let built: ValidationResult<unknown>;
  switch (state.kind) {
    case "text":
      built = textValue(fieldKey, kind, state.text);
      break;
    case "boolean":
      built = state.value === null ? { ok: false, errors: ["Choose Yes or No, or choose Not applicable / Unavailable."] } : { ok: true, value: state.value };
      break;
    case "platforms":
      built = validatePlatforms(splitPlatformText(state.text));
      break;
    case "money":
      built =
        fieldKey === "fixedComponent"
          ? buildFixedComponent({ ...state.draft, applicable: true })
          : fieldKey === "accountTransferFee"
            ? buildAccountTransferFee({ ...state.draft, applicable: true })
            : buildAdvancePayment({ ...state.draft, applicable: true });
      break;
    case "incentive":
      built = buildIncentive({ applicable: true, narrativeText: state.narrativeText, slabs: state.slabs });
      break;
    case "lfcSfc":
      built = buildLfcSfc({ ruleRef: state.ruleRef, rows: state.rows });
      break;
    case "targets":
      built = buildPerformanceTargets(state.rows);
      break;
    case "obligations":
      built = buildContentObligations(state.rows);
      break;
  }
  if (!built.ok) return built;
  // The registry's own check is the final authority: a client rule can never be looser than the server's.
  return validateFieldValue(fieldKey, "CORRECTED", built.value);
}

// True when nothing has been entered (an untouched blank editor should read as "no value", not as an error wall).
export function isEditorStateBlank(state: FieldEditorState): boolean {
  switch (state.kind) {
    case "text":
    case "platforms":
      return state.text.trim().length === 0;
    case "boolean":
      return state.value === null;
    case "money":
      return state.draft.amountText.trim().length === 0 && (state.draft.details ?? "").trim().length === 0;
    case "incentive":
      return state.slabs.length === 0 && state.narrativeText.trim().length === 0;
    case "lfcSfc":
      return state.rows.length === 0;
    case "targets":
      return state.rows.length === 0;
    case "obligations":
      return state.rows.length === 0;
  }
}
