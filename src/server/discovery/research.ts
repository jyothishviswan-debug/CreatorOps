import { TARGET_AUDIENCES, type LeadResearch, type TargetAudience } from "./types";

const TARGET_AUDIENCE_SET: ReadonlySet<string> = new Set(TARGET_AUDIENCES);

export function isApprovedTargetAudience(value: unknown): value is TargetAudience {
  return typeof value === "string" && TARGET_AUDIENCE_SET.has(value);
}

// Step 6A section 3: THE one shared canonical Research-completion
// function - used by server transition checks, readiness, conversion,
// tests, and (Step 6B) UI eligibility. Research is complete if and only
// if exactly one approved Target Audience has been recorded. Every other
// field on LeadResearch (language, location, category, notes, follower
// count) is optional context and MUST NOT participate in this gate, no
// matter how populated it is - an otherwise-thorough research record
// with an unapproved or missing Target Audience is still incomplete.
export function isResearchComplete(research: LeadResearch | null): boolean {
  if (!research) return false;
  return isApprovedTargetAudience(research.targetAudience);
}
