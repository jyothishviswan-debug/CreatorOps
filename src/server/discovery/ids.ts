import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles - pure random, same pattern as
// generateUserRef (src/server/authz/user-ref.ts). Each encodes nothing
// about its underlying Firestore document id; resolution is always a
// strict-equality lookup.
export function generateLeadRef(): string {
  return randomUUID();
}

export function generatePartnerRef(): string {
  return randomUUID();
}

export function generatePartnerAccountRef(): string {
  return randomUUID();
}
