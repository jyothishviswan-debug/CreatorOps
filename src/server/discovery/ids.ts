import { randomUUID } from "node:crypto";

// Opaque, browser-facing handle - pure random, same pattern as
// generateUserRef (src/server/authz/user-ref.ts). Encodes nothing about
// its underlying Firestore document id; resolution is always a
// strict-equality lookup. Partner/Partner Account ref generators moved
// to @/server/partners/ids.ts (Step 7A) - Partners is its own canonical
// domain now, not a Discovery-owned concept.
export function generateLeadRef(): string {
  return randomUUID();
}
