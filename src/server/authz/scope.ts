import { getScopeAssignmentDoc } from "./firestore";
import type { ActorContext, ScopeAssignmentDoc } from "./types";

// Record Scope: a representative, single-dimension (region) scope check.
// Fails closed - a missing or malformed scopeAssignments/{uid} document
// resolves to null, and every caller must treat null as "deny", never as
// "unscoped means everything". Step 4B intentionally does not wire this
// into any real business record yet (see module header); it's a tested,
// standalone primitive for later modules to build on.
export async function getActorScope(actor: ActorContext): Promise<ScopeAssignmentDoc | null> {
  return getScopeAssignmentDoc(actor.uid);
}

// Pure - the actual scope decision, kept separate from the Firestore read
// so it's trivial to unit test with fabricated inputs. `scope` must
// already be a validated, non-null ScopeAssignmentDoc; callers that got
// null from getActorScope must deny before ever reaching here.
export function isRecordInScope(scope: ScopeAssignmentDoc, recordRegion: string): boolean {
  if (!recordRegion) return false;
  return scope.regions.includes(recordRegion);
}
