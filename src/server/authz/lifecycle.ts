// Lifecycle Preconditions: a record may only move into a given next state
// from a state explicitly listed as a valid predecessor. Pure and
// standalone on purpose - Step 3B's module skeleton is fixture-only (no
// real Firestore business records exist yet), so this stage isn't wired
// into any route; it's a tested, representative primitive for later
// modules to build their own transition maps on top of.
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

export function canTransitionLifecycle(currentState: string, nextState: string, transitions: LifecycleTransitionMap): boolean {
  const allowedFrom = transitions[nextState];
  if (!allowedFrom) return false;
  return allowedFrom.includes(currentState);
}
