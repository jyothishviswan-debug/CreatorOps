// Lifecycle Preconditions: a record may only move into a given next state
// from a state explicitly listed as a valid predecessor. Pure and
// standalone on purpose. Originally a representative, unwired primitive
// (Step 3B); Step 6A's Discovery domain is the first real caller (see
// LEAD_LIFECYCLE_TRANSITIONS and src/server/discovery/lifecycle-service.ts).
export type LifecycleTransitionMap = Readonly<Record<string, readonly string[]>>;

// Step 11A: the canonical Content lifecycle - TWO separate transition
// graphs, one per review policy, replacing the earlier UI-skeleton-era
// placeholder above (which used display-label keys matching only
// src/features/content/fixtures, never a real accepted status enum or
// service). Content's real status enum
// (PLANNED/IN_PRODUCTION/SUBMITTED/CHANGES_REQUIRED/APPROVED/REJECTED/
// POSTED/COMPLETED/CANCELLED) lives in src/server/content/types.ts.
//
// REVIEW_REQUIRED: PLANNED -> IN_PRODUCTION -> SUBMITTED, then a review
// decision (APPROVED/CHANGES_REQUIRED/REJECTED); CHANGES_REQUIRED loops
// directly back to SUBMITTED (a resubmission with a newer version - see
// content-lifecycle-service.ts - never a second, formal IN_PRODUCTION
// status transition in between, since production/version-saving is
// already legal while CHANGES_REQUIRED). POSTED is reachable only from
// APPROVED (never precedes it). CANCELLED is reachable from every
// pre-POSTED state including REJECTED (a reasoned close-out of a dead-end
// record) but NOT from POSTED/COMPLETED, matching "cannot cancel after
// canonical publication evidence exists" / "cannot cancel COMPLETED".
export const CONTENT_REVIEW_REQUIRED_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  PLANNED: [],
  IN_PRODUCTION: ["PLANNED"],
  SUBMITTED: ["IN_PRODUCTION", "CHANGES_REQUIRED"],
  CHANGES_REQUIRED: ["SUBMITTED"],
  APPROVED: ["SUBMITTED"],
  REJECTED: ["SUBMITTED"],
  POSTED: ["APPROVED"],
  COMPLETED: ["POSTED"],
  CANCELLED: ["PLANNED", "IN_PRODUCTION", "SUBMITTED", "CHANGES_REQUIRED", "APPROVED", "REJECTED"],
};

// NO_PREPOST_REVIEW: PLANNED -> IN_PRODUCTION -> POSTED -> COMPLETED.
// SUBMITTED/CHANGES_REQUIRED/APPROVED/REJECTED are deliberately absent
// keys entirely (not merely empty arrays) - a target key absent from the
// table is structurally unreachable (canTransitionLifecycle returns
// false), which is exactly how this policy's "can never enter review
// states" rule is enforced, with no separate runtime business-rule check
// needed. CANCELLED excludes POSTED (publication evidence already
// exists there) and COMPLETED, same rule as the REVIEW_REQUIRED graph.
export const CONTENT_NO_PREPOST_REVIEW_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  PLANNED: [],
  IN_PRODUCTION: ["PLANNED"],
  POSTED: ["IN_PRODUCTION"],
  COMPLETED: ["POSTED"],
  CANCELLED: ["PLANNED", "IN_PRODUCTION"],
};

// Step 6A: the canonical, frozen greenfield compact Discovery Lead
// lifecycle. Deliberately a strict linear pipeline for the main path
// (each state's only valid predecessor is the one immediately before it
// in the canonical list) - "frozen" is read literally here, not as a
// loose ordering suggestion. WATCHLIST/REJECTED/ARCHIVED are reachable
// as a reasoned "set aside" from any active pre-conversion state;
// ARCHIVED is also reachable from WATCHLIST/REJECTED directly (no
// forced restore round-trip). DUPLICATE is reachable from any
// pre-conversion state, including from WATCHLIST/REJECTED, and is
// terminal - it has no entry here as a source, and nothing lists it as
// an allowed predecessor.
//
// CONVERTED is deliberately NOT reachable through this generic map at
// all (empty predecessor list) - it is only ever set by the dedicated,
// transactional convertLead() service (see
// src/server/discovery/conversion-service.ts), never through the
// generic manual-transition endpoint.
//
// Restoring out of WATCHLIST/REJECTED/ARCHIVED back to whatever state
// preceded it is NOT modeled here either - the target is dynamic (the
// Lead's own recorded `previousLifecycle`), not a fixed predecessor set,
// so it's implemented as its own function (restoreLead) rather than a
// static table entry.
const LEAD_ACTIVE_STATES = ["NEW", "RESEARCHING", "CONTACTED", "RESPONDED", "EVALUATING", "CONVERSION_READY"] as const;

export const LEAD_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  NEW: [],
  RESEARCHING: ["NEW"],
  CONTACTED: ["RESEARCHING"],
  RESPONDED: ["CONTACTED"],
  EVALUATING: ["RESPONDED"],
  CONVERSION_READY: ["EVALUATING"],
  CONVERTED: [],
  WATCHLIST: LEAD_ACTIVE_STATES,
  REJECTED: LEAD_ACTIVE_STATES,
  ARCHIVED: [...LEAD_ACTIVE_STATES, "WATCHLIST", "REJECTED"],
  DUPLICATE: [...LEAD_ACTIVE_STATES, "WATCHLIST", "REJECTED"],
};

// Step 9A: the canonical Campaign lifecycle. No restore from ARCHIVED is
// ever modeled (frozen authority is explicit) - CANCELLED and ARCHIVED
// are both one-way terminal-adjacent states, reached only through their
// own reasoned transition (see campaign-lifecycle-service.ts). Keyed by
// target state -> its allowed predecessor states, same convention as
// LEAD_LIFECYCLE_TRANSITIONS above.
export const CAMPAIGN_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  DRAFT: ["PLANNED"],
  PLANNED: ["DRAFT"],
  ACTIVE: ["PLANNED", "PAUSED"],
  PAUSED: ["ACTIVE"],
  COMPLETED: ["ACTIVE"],
  CANCELLED: ["DRAFT", "PLANNED", "ACTIVE", "PAUSED"],
  ARCHIVED: ["COMPLETED", "CANCELLED"],
};

// Step 10A: the canonical, compact Assignment execution lifecycle -
// deliberately execution-level only, never duplicating Content/review
// states (no SUBMITTED/APPROVED/REVISION_REQUESTED/POSTED/PUBLISHED
// here - those are Content's own future territory). CANCELLED is reached
// from every non-terminal state per the authority doc's own guarded list;
// COMPLETED and CANCELLED are both terminal (neither appears as an
// allowed predecessor of anything). IN_PROGRESS -> CANCELLED is
// unconditionally allowed for now ("only while cancellation remains
// reversible" - Step 10A section 5); the intended future check ("does
// irreversible Content/publication evidence exist yet") has an explicit
// extension point in assignment-lifecycle-service.ts's own comment, since
// Content doesn't exist yet to check against.
export const ASSIGNMENT_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  DRAFT: [],
  ASSIGNED: ["DRAFT"],
  ACCEPTED: ["ASSIGNED"],
  IN_PROGRESS: ["ACCEPTED"],
  COMPLETED: ["IN_PROGRESS"],
  CANCELLED: ["DRAFT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS"],
};

export function canTransitionLifecycle(currentState: string, nextState: string, transitions: LifecycleTransitionMap): boolean {
  const allowedFrom = transitions[nextState];
  if (!allowedFrom) return false;
  return allowedFrom.includes(currentState);
}
