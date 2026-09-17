import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles - pure random, same pattern as
// generatePartnerRef/generateLeadRef. Encodes nothing about the
// underlying Firestore document id; resolution is always a strict-
// equality lookup.
export function generateVendorRef(): string {
  return randomUUID();
}

export function generateVendorPartnerLinkRef(): string {
  return randomUUID();
}
