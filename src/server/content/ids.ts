import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles - pure random, same pattern as
// generateAssignmentRef/generateCampaignRef/generatePartnerRef. Encodes
// nothing about the underlying Firestore document id.
export function generateContentRef(): string {
  return randomUUID();
}
