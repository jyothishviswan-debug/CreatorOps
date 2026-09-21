import { QUALIFYING_UNIT_OPTIONS, isSupportedQualifyingUnit, type SupportedQualifyingUnit } from "./format";

// Step 14B: the qualifying-unit control rules (pure). Step 14A honours exactly two operational units:
//   approved_content_thread -> "Approved Content"        approved_current_link -> "Approved current link"
// Anything else an extractor wrote ("reel", "video", "post" ...) is displayed AS WRITTEN and marked `Needs mapping`:
// it is NEVER silently mapped to a supported unit - the person chooses a supported unit, or leaves the requirement Unavailable.
export type QualifyingUnitMapping =
  | { state: "SUPPORTED"; value: SupportedQualifyingUnit; label: string }
  | { state: "NEEDS_MAPPING"; extractedWording: string }
  | { state: "NONE" };

export function mapQualifyingUnit(value: unknown): QualifyingUnitMapping {
  if (typeof value !== "string" || value.trim().length === 0) return { state: "NONE" };
  if (isSupportedQualifyingUnit(value)) return { state: "SUPPORTED", value, label: QUALIFYING_UNIT_OPTIONS.find((option) => option.value === value)!.label };
  return { state: "NEEDS_MAPPING", extractedWording: value.trim() };
}

// The options the dropdown offers: the two supported units only (no free text), in a fixed order.
export const QUALIFYING_UNIT_SELECT_OPTIONS = QUALIFYING_UNIT_OPTIONS.map((option) => ({ value: option.value as string, label: option.label }));

// A required content count and its qualifying unit go together (server rule): the count needs a unit and a unit needs a count.
// `count`/`unit` are the DECIDED values (null = not stated). Returns the field the person still has to resolve, if any.
export function qualifyingPairIssue(count: number | null, unit: string | null): { fieldKey: "monthlyRequiredQualifyingContentCount" | "qualifyingUnit"; message: string } | null {
  if (count !== null && unit === null) return { fieldKey: "qualifyingUnit", message: "A required content count needs its qualifying unit. Choose Approved Content or Approved current link, or set the count to Unavailable." };
  if (count === null && unit !== null) return { fieldKey: "monthlyRequiredQualifyingContentCount", message: "A qualifying unit needs its required content count." };
  if (unit !== null && !isSupportedQualifyingUnit(unit)) return { fieldKey: "qualifyingUnit", message: "Choose a supported qualifying unit (Approved Content or Approved current link)." };
  return null;
}
