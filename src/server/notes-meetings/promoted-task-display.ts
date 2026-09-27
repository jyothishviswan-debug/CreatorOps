import { getTask } from "@/server/operations";
import type { ActorContext } from "@/server/authz/types";

// Notes/Meetings Completion (spec section 15: never show a raw internal ref as a primary label). A
// MeetingActionItem's own promotedTaskDisplayName must resolve the SAME way whether it is shown right
// after promotion (promotion.ts's own response) or on any later read (action-item-service.ts's
// getActionItem/listActionItems) - kept in its own small file (not inside either of those) so neither
// has to import the other, avoiding a circular dependency between promotion.ts and
// action-item-service.ts. A denial or a since-deleted Task both resolve to null - the UI then falls
// back to a short ref fragment, never a fabricated name.
export async function resolvePromotedTaskDisplayName(actor: ActorContext | null, taskRef: string | null): Promise<string | null> {
  if (!taskRef) return null;
  try {
    const result = await getTask(actor, taskRef);
    return result.ok ? result.data.title : null;
  } catch {
    return null;
  }
}
