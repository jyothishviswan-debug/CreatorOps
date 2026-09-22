import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { IncentiveSlab, PerformanceTarget } from "@/server/finance-agreements/terms";

import { formatFieldValue, incentiveSlabSummary, performanceTargetSummary } from "../../field-values";
import { NO_VALUE_TEXT } from "../../format";

// Step 14B (intake): a candidate value (an extracted proposal, a current draft value) as short, wrapped display LINES (pure).
// A scalar is one line; a structured value (slabs, targets, LFC / SFC formats) is one line per row, so a long list
// reads as a short list instead of a giant string.
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function titleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

export function valueLines(fieldKey: AgreementFieldKey, value: unknown, context: { currency?: string | null } = {}): string[] {
  if (value === null || value === undefined) return [NO_VALUE_TEXT];
  const currency = context.currency ?? null;
  if (fieldKey === "incentive" && isRecord(value) && value.applicable === true && Array.isArray(value.slabs) && value.slabs.length > 0) {
    return (value.slabs as IncentiveSlab[]).map((slab) => incentiveSlabSummary(slab, currency));
  }
  if (fieldKey === "performanceTargets" && Array.isArray(value) && value.length > 0) {
    return (value as PerformanceTarget[]).map((target) => performanceTargetSummary(target));
  }
  if (fieldKey === "lfcSfc" && isRecord(value) && isRecord(value.byFormat)) {
    // Display only: the Agreement's own format wording (often a full lowercase clause phrase, e.g. "long format audio
    // visual content") reads as a title rather than raw contract text. The stored key is untouched.
    const rows = Object.entries(value.byFormat).map(([format, kind]) => `${titleCase(format)}: ${String(kind)}`);
    return rows.length > 0 ? rows : [NO_VALUE_TEXT];
  }
  return [formatFieldValue(fieldKey, value, { currency })];
}
