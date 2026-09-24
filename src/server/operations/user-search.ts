import { listUserDocs } from "@/server/authz/firestore";
import type { ActorContext } from "@/server/authz/types";

import { requireOperationsAccess } from "./operations-gate";
import { operationsInvalidInputResult, operationsUnauthorizedResult, type OperationsServiceResult } from "./types";

// Step 18B follow-up (a genuine integration gap, fixed minimally): the assignee/owner picker needs
// a BOUNDED active-user search reachable by anyone who can even see Operations (a Partnership
// Manager/Head assigning their own team's work) - never the Administration module's own
// `/api/administration/users` (that endpoint requires the `manage_users` administration action,
// which most Operations actors correctly do NOT hold; wiring the picker to it meant only a Super
// Admin could ever pick an assignee, silently breaking Create Task/Create Reminder for every other
// role). This mirrors requireAdmittedActiveUser's own single-user check (operations-gate.ts) at
// list scale: the same safe, non-sensitive users/{uid} fields (displayName/email/role/active),
// gated only by the base `operations` feature - never administration, never a raw uid as the
// primary label.
export type OperationsUserOption = { userRef: string; displayName: string | null; email: string; role: string; active: boolean };

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

export async function searchActiveOperationsUsers(actor: ActorContext | null, rawQuery: unknown): Promise<OperationsServiceResult<{ users: OperationsUserOption[] }>> {
  const access = await requireOperationsAccess(actor);
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const query = (rawQuery ?? {}) as Record<string, unknown>;
  let emailPrefix: string | undefined;
  if (query.emailPrefix !== undefined) {
    if (typeof query.emailPrefix !== "string") return operationsInvalidInputResult("emailPrefix must be a string.");
    emailPrefix = query.emailPrefix.toLowerCase();
  }
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "number" || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) return operationsInvalidInputResult(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
    limit = query.limit;
  }

  const page = await listUserDocs({ limit, active: true, emailPrefix });
  return { ok: true, data: { users: page.users.map((user) => ({ userRef: user.userRef, displayName: user.displayName, email: user.email, role: user.role, active: user.active })) } };
}
