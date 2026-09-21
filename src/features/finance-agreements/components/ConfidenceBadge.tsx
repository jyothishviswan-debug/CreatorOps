import type { ExtractionConfidence } from "@/server/finance-agreements/types";

import { confidenceChip } from "../format";

import { pillClassName } from "./display-logic";

// The extractor's coarse confidence as visible text ("Confidence: High"). A heuristic only - it never
// decides anything and never replaces the human "Needs confirmation" step.
export function ConfidenceBadge({ confidence }: { confidence: ExtractionConfidence | null | undefined }) {
  const chip = confidenceChip(confidence);
  return (
    <span className={pillClassName(chip.tone)} data-confidence={confidence ?? "UNKNOWN"}>
      Confidence: {chip.label}
    </span>
  );
}
