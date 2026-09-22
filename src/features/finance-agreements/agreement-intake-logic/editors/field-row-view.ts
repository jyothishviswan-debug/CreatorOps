import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { ExtractionConfidence } from "@/server/finance-agreements/types";

import { deepEqual } from "../../field-values";
import type { FieldViewModel } from "../../field-view-model";
import { NO_VALUE_TEXT, qualifyingUnitLabel, type ChipSpec } from "../../format";
import type { FieldChange } from "../../revision-diff";
import type { LocalFieldEdit } from "../intake-logic";

import { valueLines } from "./value-lines";

// Step 14B (intake): the display model of ONE field row (pure). It answers, for a registry field: what does the Agreement hold for it
// now, where did that come from, is there an unaccepted proposal, is there an unsaved edit - all as visible TEXT.

export type FieldRowView = {
  fieldKey: AgreementFieldKey;
  label: string;
  statusChip: ChipSpec;
  unsaved: boolean;
  requiredText: string | null;
  // What the Agreement holds (or will hold after the unsaved edit).
  currentKind: "value" | "unavailable" | "not_applicable" | "none";
  currentLines: string[];
  // "Proposed from Agreement" / "Prefilled from CreatorOps master data" / "Manual" (null: no draft entry).
  sourceText: string | null;
  origin: FieldViewModel["origin"];
  // The value on show is an unaccepted proposal / prefill (decision PENDING).
  isProposal: boolean;
  confidence: ExtractionConfidence | null;
  page: number | null;
  // The Agreement's own proposal, shown separately when the person decided a different value.
  agreementProposedLines: string[] | null;
  // Qualifying unit only: the wording is not a supported unit and must be mapped by the person.
  needsMapping: boolean;
  extractedWording: string | null;
  // "Use ..." may accept the candidate value as it is (never for an unmapped qualifying unit).
  canUseCandidate: boolean;
  changedFromPrevious: { beforeText: string } | null;
};

export const UNSAVED_CHIP: ChipSpec = { label: "Unsaved change", tone: "orange" };

export function requiredTextOf(model: Pick<FieldViewModel, "requiredForConfirm" | "requiredWhen">): string | null {
  if (model.requiredForConfirm === "always") return "Required";
  if (model.requiredForConfirm === "conditional" && model.requiredWhen) return `Required when ${model.requiredWhen}`;
  return null;
}

function sourceTextFor(model: Pick<FieldViewModel, "origin" | "decision">): string | null {
  if (!model.origin) return null;
  const pending = model.decision === "PENDING";
  if (model.origin === "EXTRACTED") return pending ? "Proposed from Agreement" : "From Agreement";
  if (model.origin === "MASTER_DATA") return pending ? "Prefilled from CreatorOps master data" : "CreatorOps master data";
  return "Manual";
}

export function buildFieldRowView(input: { model: FieldViewModel; pending?: LocalFieldEdit; currency: string | null; changes?: readonly FieldChange[] | null }): FieldRowView {
  const { model, pending, currency } = input;
  const decision = pending?.decision ?? model.decision;
  const pendingValue = pending && pending.value !== undefined ? pending.value : undefined;

  let currentKind: FieldRowView["currentKind"] = "none";
  let currentLines: string[] = [NO_VALUE_TEXT];
  if (decision === "UNAVAILABLE") {
    currentKind = "unavailable";
    currentLines = ["Unavailable"];
  } else if (decision === "NOT_APPLICABLE") {
    currentKind = "not_applicable";
    currentLines = ["Not applicable"];
  } else if (pendingValue !== undefined) {
    currentKind = "value";
    currentLines = valueLines(model.fieldKey, pendingValue, { currency });
  } else if (model.hasValue) {
    currentKind = "value";
    currentLines = valueLines(model.fieldKey, model.value, { currency });
  }

  const isProposal = pending === undefined && model.decision === "PENDING" && model.hasValue;
  // The Agreement's proposal is shown apart only when it differs from what is on show.
  const proposedDiffers = model.extractedValue !== null && model.extractedValue !== undefined && (pendingValue !== undefined ? !deepEqual(model.extractedValue, pendingValue) : !deepEqual(model.extractedValue, model.value));
  const agreementProposedLines = proposedDiffers ? valueLines(model.fieldKey, model.extractedValue, { currency }) : null;

  let extractedWording: string | null = null;
  if (model.needsMapping) {
    const wording = [pendingValue, model.value, model.extractedValue].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0 && qualifyingUnitLabel(candidate) === candidate);
    extractedWording = typeof wording === "string" ? wording.trim() : null;
  }

  const change = input.changes?.find((item) => item.fieldKey === model.fieldKey);
  return {
    fieldKey: model.fieldKey,
    label: model.label,
    statusChip: model.statusChip,
    unsaved: pending !== undefined,
    requiredText: requiredTextOf(model),
    currentKind,
    currentLines,
    sourceText: sourceTextFor(model),
    origin: model.origin,
    isProposal,
    confidence: model.origin === "EXTRACTED" ? (model.provenance?.confidence ?? null) : null,
    page: model.origin === "EXTRACTED" ? (model.provenance?.page ?? null) : null,
    agreementProposedLines,
    needsMapping: model.needsMapping,
    extractedWording,
    canUseCandidate: model.hasValue && !model.needsMapping,
    changedFromPrevious: change ? { beforeText: change.beforeText } : null,
  };
}

