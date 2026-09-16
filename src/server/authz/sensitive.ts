import { getSensitiveAccessGrantDoc } from "./firestore";
import type { ActorContext } from "./types";

// Sensitive Access: a distinct gate from Feature Access - a role can see
// a feature (e.g. Finance) without being granted every sensitive
// category within it (e.g. exact settlement amounts). Explicit per-role
// category list; a missing/malformed grant document fails closed.
export async function canAccessSensitive(actor: ActorContext, category: string): Promise<boolean> {
  const grant = await getSensitiveAccessGrantDoc(actor.role);
  if (!grant) return false;
  return grant.categories.includes(category);
}
