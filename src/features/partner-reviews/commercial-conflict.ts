// Step 14C: the presentation of an OVERLAP conflict in the commercial evidence - pure, no React. More than
// one applicable Agreement covers the Partner-month, so Partner Reviews shows the commercial evidence as
// unavailable and says why, in exactly one wording. It never names or picks an Agreement (the actor view
// carries only how many collided) and never offers to merge: the overlap is resolved in the Agreement
// workflow, after which the review is simply refreshed.

export const COMMERCIAL_CONFLICT_TEXT = "Multiple applicable Agreements require resolution";
export const COMMERCIAL_CONFLICT_NOTE = "Partner Reviews does not choose between Agreements or merge them. The overlap is resolved in the Agreement workflow, and this review can then be refreshed.";
// A shorter, distinct status for the review header (the exact sentence above appears once, in the commercial panel).
export const COMMERCIAL_CONFLICT_HEADER_LABEL = "Agreement overlap · commercial evidence unavailable";
// The per-section "why unavailable" line (also distinct from the exact sentence).
export const COMMERCIAL_CONFLICT_SECTION_REASON = "Not evaluated: more than one applicable Agreement covers this month.";

export type CommercialConflictNotice = { text: string; note: string; conflictCount: number };

// null when the snapshot carries no conflict marker (every conflict-free and every older stored version).
export function commercialConflictNotice(commercial: { policyConflict?: { reason: string; conflictCount: number } | undefined }): CommercialConflictNotice | null {
  const conflict = commercial.policyConflict;
  if (!conflict || conflict.reason !== "multiple_applicable_agreements") return null;
  return { text: COMMERCIAL_CONFLICT_TEXT, note: COMMERCIAL_CONFLICT_NOTE, conflictCount: conflict.conflictCount };
}
