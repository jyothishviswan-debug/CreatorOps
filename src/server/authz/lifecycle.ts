// Lifecycle Preconditions: a record may only move into a given next state
// from a state explicitly listed as a valid predecessor. Pure and
// standalone on purpose. Originally a representative, unwired primitive
// (Step 3B); Step 6A's Discovery domain is the first real caller (see
// LEAD_LIFECYCLE_TRANSITIONS and src/server/discovery/lifecycle-service.ts).
export type LifecycleTransitionMap = Readonly<Record<string, readonly string[]>>;

// Step 11A.1: the canonical Content lifecycle - ONE transition graph,
// replacing Step 11A/11B's two separate review-policy-keyed graphs above
// (the whole two-policy distinction is retired: review is now ALWAYS
// required, unconditionally, for every thread). Content's real status
// enum (OPEN/UNDER_REVIEW/REVISION_REQUESTED/APPROVED/CANCELLED) lives in
// src/server/content/types.ts.
//
// OPEN -> UNDER_REVIEW happens only via the public submit route (never
// through this generic table's own caller - see
// external-submission-service.ts's submitExternalLinks). UNDER_REVIEW's
// two Manager decisions are REVISION_REQUESTED (reopens the SAME public
// page/token for correction) or APPROVED (closes the thread - finality,
// matching section 11's "approved = closed"). REVISION_REQUESTED loops
// back to UNDER_REVIEW on resubmission (same public route). CANCELLED is
// reachable from OPEN/UNDER_REVIEW/REVISION_REQUESTED but NOT from
// APPROVED - there is no predecessor-of-anything entry for CANCELLED
// itself, and APPROVED is deliberately absent from CANCELLED's own
// allowed-predecessor list.
export const CONTENT_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  OPEN: [],
  UNDER_REVIEW: ["OPEN", "REVISION_REQUESTED"],
  REVISION_REQUESTED: ["UNDER_REVIEW"],
  APPROVED: ["UNDER_REVIEW"],
  CANCELLED: ["OPEN", "UNDER_REVIEW", "REVISION_REQUESTED"],
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
