import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles - pure random, same pattern as
// generateLeadRef/generateUserRef. Encodes nothing about the underlying
// Firestore document id; resolution is always a strict-equality lookup.
export function generatePartnerRef(): string {
  return randomUUID();
}

export function generatePartnerAccountRef(): string {
  return randomUUID();
}
