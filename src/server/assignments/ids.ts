import { randomUUID } from "node:crypto";

// Opaque, browser-facing handles - pure random, same pattern as
// generateCampaignRef/generateVendorRef/generatePartnerRef. Encodes
// nothing about the underlying Firestore document id; resolution is
// always a strict-equality lookup.
export function generateAssignmentRef(): string {
  return randomUUID();
}

// The external-submission session's own staff-facing opaque handle -
// distinct from its doc id (which is the token's sha256 hash, never
// exposed to any staff DTO). See external-submission-types.ts's own
// comment on assignmentSubmissionSessionDocSchema.
export function generateSubmissionSessionRef(): string {
  return randomUUID();
}

export function generateSubmissionRef(): string {
  return randomUUID();
}
