// Lifecycle Preconditions: a record may only move into a given next state
// from a state explicitly listed as a valid predecessor. Pure and
// standalone on purpose. Originally a representative, unwired primitive
// (Step 3B); Step 6A's Discovery domain is the first real caller (see
// LEAD_LIFECYCLE_TRANSITIONS and src/server/discovery/lifecycle-service.ts).
export type LifecycleTransitionMap = Readonly<Record<string, readonly string[]>>;

// Representative content-publication lifecycle, matching the Content
// module's existing fixture statuses (src/features/content/fixtures).
// Each key's value lists the states allowed to precede it.
export const CONTENT_LIFECYCLE_TRANSITIONS: LifecycleTransitionMap = {
  Planned: [],
  Submitted: ["Planned"],
  "Needs changes": ["Submitted"],
  Approved: ["Submitted"],
  Posted: ["Approved"],
  Completed: ["Posted"],
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

export function canTransitionLifecycle(currentState: string, nextState: string, transitions: LifecycleTransitionMap): boolean {
  const allowedFrom = transitions[nextState];
  if (!allowedFrom) return false;
  return allowedFrom.includes(currentState);
}
