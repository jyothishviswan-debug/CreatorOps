import { randomUUID } from "node:crypto";

import { partnerReviewEventsCollection } from "./firestore";
import { partnerReviewEventSchema, type PartnerReviewEvent, type PartnerReviewEventKind } from "./types";

// Same defense-in-depth redaction discipline as Assignments'/Content's
// own events modules - a caller mistake must never leak a token, secret or
// restricted value into this durable, append-only collection.
const FORBIDDEN_METADATA_KEY_SUBSTRINGS = ["password", "token", "secret", "credential", "cookie", "pan", "bank", "ifsc", "iban", "account_number", "accountnumber", "gst", "amount", "rate"];

function redact(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEY_SUBSTRINGS.some((bad) => lower.includes(bad))) continue;
    clean[key] = value;
  }
  return clean;
}

export type PartnerReviewEventInput = {
  reviewRef: string;
  kind: PartnerReviewEventKind;
  version: number;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
  createdAt: string;
};

// Appends one event INSIDE the caller's Firestore transaction, so a
// mutation and its audit event commit atomically (an accepted mutation can
// never lack its event, and a rolled-back one never leaves a phantom
// event). Never deleted, never rewritten. Must be called after every read
// the transaction needs (Firestore requires all reads before writes).
export function appendPartnerReviewEvent(tx: FirebaseFirestore.Transaction, input: PartnerReviewEventInput): void {
  const event: PartnerReviewEvent = partnerReviewEventSchema.parse({
    kind: input.kind,
    version: input.version,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: input.createdAt,
  });
  tx.set(partnerReviewEventsCollection(input.reviewRef).doc(randomUUID()), event);
}
