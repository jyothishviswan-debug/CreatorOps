import { createHash, randomUUID } from "node:crypto";

// Step 18A: Operations identity + the deterministic idempotency-key discipline section 8 requires
// ("one follow-up Task per exact source event", "one Reminder per task/source + recipient +
// reminderAt", "one Approval projection per exact source action/version").
//
// taskRef/reminderRef are opaque random handles (a Task/Reminder is not itself a deterministic
// per-source record - many Tasks can legitimately exist for the same target) - mirrors Payment's own
// `pmt_` ref exactly. Idempotency for a SYSTEM-GENERATED Task/Reminder is instead enforced by a
// separate deterministic sourceKey plus a transactional claim document (see firestore.ts's
// txCreateTaskGenerationClaim/txCreateReminderGenerationClaim), the same "claim doc read/created
// inside the same transaction as the record it protects" shape as
// financePaymentReferenceClaims/paymentReferenceClaimId.

function randomHex20(): string {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

export function generateTaskRef(): string {
  return `tsk_${randomHex20()}`;
}

export function generateReminderRef(): string {
  return `rmd_${randomHex20()}`;
}

// A deterministic, human-decodable source key for a system-generated Task/Reminder, built from its
// exact origin and the immutable facts of the triggering source event - never from wall-clock time,
// never from a random value. Two calls with identical inputs always produce the identical key, so
// the generation transaction's claim-doc read is what makes generation idempotent under
// concurrency (see task-lifecycle-service.ts's generateSystemTask / reminder-lifecycle-service.ts's
// generateSystemReminder).
export function buildSourceKey(parts: { origin: string; targetType: string; targetRef: string; targetVersion?: number | null; qualifier: string }): string {
  const version = parts.targetVersion ?? "none";
  return `${parts.origin}|${parts.targetType}|${parts.targetRef}|${version}|${parts.qualifier}`;
}

// The Firestore-doc-id-safe form of a sourceKey (a raw sourceKey may contain characters a doc id
// disallows, e.g. "/") - deterministic, collision-resistant, never reversed back into the original
// key (the claim document itself stores the original key verbatim for audit/debugging).
export function sourceKeyDocId(sourceKey: string): string {
  return createHash("sha256").update(sourceKey).digest("hex").slice(0, 48);
}

// The deterministic ref for one Approval Queue projection item (section 6/8: "one Approval
// projection per exact source action/version"). Pure function of the source coordinates - never
// random, never dependent on when the projection was computed, so refreshing the same pending
// source action always yields the SAME approvalItemRef.
export function buildApprovalItemRef(parts: { sourceModule: string; sourceType: string; sourceRef: string; sourceVersion: number; actionType: string }): string {
  const hash = createHash("sha256").update(`${parts.sourceModule}|${parts.sourceType}|${parts.sourceRef}|${parts.sourceVersion}|${parts.actionType}`).digest("hex").slice(0, 40);
  return `apr_${hash}`;
}
