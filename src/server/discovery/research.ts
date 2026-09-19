import { TARGET_AUDIENCES, type LeadResearch, type TargetAudience } from "./types";

const TARGET_AUDIENCE_SET: ReadonlySet<string> = new Set(TARGET_AUDIENCES);

export function isApprovedTargetAudience(value: unknown): value is TargetAudience {
  return typeof value === "string" && TARGET_AUDIENCE_SET.has(value);
}

// Step 6A section 3 (revised): THE one shared canonical Research-
// completion function - used by server transition checks, readiness,
// conversion, tests, and (Step 6B) UI eligibility. Research is complete
// if and only if AT LEAST ONE approved Target Audience has been
// recorded (a Lead may span more than one segment). Every other field on
// LeadResearch (language, location, category, notes, follower count) is
// optional context and MUST NOT participate in this gate, no matter how
// populated it is - an otherwise-thorough research record with zero
// approved Target Audience values is still incomplete.
export function isResearchComplete(research: LeadResearch | null): boolean {
  if (!research) return false;
  return research.targetAudience.some(isApprovedTargetAudience);
}
