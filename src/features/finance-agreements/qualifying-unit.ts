import { QUALIFYING_UNIT_OPTIONS, isSupportedQualifyingUnit, type SupportedQualifyingUnit } from "./format";

// Step 14B: the qualifying-unit control rules (pure). Anything an extractor wrote that isn't a
// recognized unit ("reel", "video", "post" ...) is displayed AS WRITTEN and marked `Needs mapping`: it is
// NEVER silently mapped to a supported unit - the person chooses a supported unit, or leaves the
// requirement Unavailable.
export type QualifyingUnitMapping =
  | { state: "SUPPORTED"; value: SupportedQualifyingUnit; label: string }
  | { state: "NEEDS_MAPPING"; extractedWording: string }
  | { state: "NONE" };

export function mapQualifyingUnit(value: unknown): QualifyingUnitMapping {
  if (typeof value !== "string" || value.trim().length === 0) return { state: "NONE" };
  if (isSupportedQualifyingUnit(value)) return { state: "SUPPORTED", value, label: QUALIFYING_UNIT_OPTIONS.find((option) => option.value === value)!.label };
  return { state: "NEEDS_MAPPING", extractedWording: value.trim() };
}

const CURRENT_QUALIFYING_UNIT = "qualifying_analytics_post";

// Findings #30/#66 (user-decided): the options the control actually offers a person - never a technical
// choice between internal implementation concepts. A brand-new/still-unset field, or one already on the
// current unit, sees exactly ONE option ("Monthly required posts/content"). An Agreement whose
// confirmation already carries one of the two legacy units keeps that OWN option present too (so an
// existing confirmed value is never silently blanked out mid-revision) - legacy is never offered to a
// field that isn't already on it.
export function qualifyingUnitSelectOptions(currentValue: string | null | undefined): Array<{ value: string; label: string }> {
  const current = QUALIFYING_UNIT_OPTIONS.find((option) => option.value === currentValue && option.value !== CURRENT_QUALIFYING_UNIT);
  const options = QUALIFYING_UNIT_OPTIONS.filter((option) => option.value === CURRENT_QUALIFYING_UNIT);
  return current ? [...options, current] : [...options];
}

// A required content count and its qualifying unit go together (server rule): the count needs a unit and a unit needs a count.
// `count`/`unit` are the DECIDED values (null = not stated). Returns the field the person still has to resolve, if any.
export function qualifyingPairIssue(count: number | null, unit: string | null): { fieldKey: "monthlyRequiredQualifyingContentCount" | "qualifyingUnit"; message: string } | null {
  if (count !== null && unit === null) return { fieldKey: "qualifyingUnit", message: "A required content count needs its qualifying unit. Choose Monthly required posts/content, or set the count to Unavailable." };
  if (count === null && unit !== null) return { fieldKey: "monthlyRequiredQualifyingContentCount", message: "A qualifying unit needs its required content count." };
  if (unit !== null && !isSupportedQualifyingUnit(unit)) return { fieldKey: "qualifyingUnit", message: "Choose a supported qualifying unit (Monthly required posts/content)." };
  return null;
}
