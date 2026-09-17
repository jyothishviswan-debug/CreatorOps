import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles - pure random, same pattern as
// generateVendorRef/generatePartnerRef. Encodes nothing about the
// underlying Firestore document id; resolution is always a strict-
// equality lookup.
export function generateCampaignRef(): string {
  return randomUUID();
}

export function generateCampaignResourceRef(): string {
  return randomUUID();
}
