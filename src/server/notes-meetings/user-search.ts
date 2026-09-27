import { listUserDocs } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";

import { notesMeetingsInvalidInputResult, notesMeetingsUnauthorizedResult, type NotesMeetingsServiceResult } from "./types";

// Notes/Meetings Completion: a bounded active-user search for the participant/assignee picker
// (Create Meeting participants, Create/revise Action Item assignee). Deliberate design choice
// (documented in the completion report): gated on Authentication + Admission ONLY - not any single
// owning feature's own FeatureAccess - because Notes/Meetings spans SIX different owning features
// (section 13's own composition design) and picking one of them to gate a generic user search would
// arbitrarily privilege that one feature over the others. This exposes exactly the same safe,
// non-sensitive users/{uid} fields (displayName/email/role/active) that Operations' own
// searchActiveOperationsUsers already exposes to any actor holding the base `operations` feature -
// only the gate's SCOPE is broader here (any admitted active user), never the field set.
export type NotesMeetingsUserOption = { userRef: string; displayName: string | null; email: string; role: string; active: boolean };

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

export async function searchActiveUsersForNotesMeetings(actor: ActorContext | null, rawQuery: unknown): Promise<NotesMeetingsServiceResult<{ users: NotesMeetingsUserOption[] }>> {
  if (!actor) return notesMeetingsUnauthorizedResult("not_authenticated");

  const query = (rawQuery ?? {}) as Record<string, unknown>;
  let emailPrefix: string | undefined;
  if (query.emailPrefix !== undefined) {
    if (typeof query.emailPrefix !== "string") return notesMeetingsInvalidInputResult("emailPrefix must be a string.");
    emailPrefix = query.emailPrefix.toLowerCase();
  }
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "number" || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) return notesMeetingsInvalidInputResult(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
    limit = query.limit;
  }

  const page = await listUserDocs({ limit, active: true, emailPrefix });
  return { ok: true, data: { users: page.users.map((user) => ({ userRef: user.userRef, displayName: user.displayName, email: user.email, role: user.role, active: user.active })) } };
}
