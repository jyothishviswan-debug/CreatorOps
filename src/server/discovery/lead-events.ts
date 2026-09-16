import { randomUUID } from "node:crypto";

import { leadEventsCollection } from "./firestore";
import { leadEventSchema, type LeadEvent, type LeadEventKind } from "./types";

const FORBIDDEN_METADATA_KEY_SUBSTRINGS = ["password", "token", "secret", "credential", "cookie", "aadhaar", "pan", "bank", "ifsc", "iban", "account_number", "accountnumber"];

// Same defense-in-depth redaction discipline as authz/audit.ts, extended
// with the restricted-KYC field-name substrings Step 6A section 11
// explicitly forbids logging (PAN, Aadhaar, bank account, IFSC) - even
// though kyc-service.ts never passes raw values into event metadata in
// the first place, a future mistake in a caller still can't leak one
// into this durable, append-only collection.
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

export type WriteLeadEventInput = {
  leadUid: string;
  kind: LeadEventKind;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
};

// The append-only per-Lead event/evidence history - Step 6A's answer to
// "no unbounded history arrays on the root Lead document" AND "material
// Discovery mutations must create safe append-only audit events" at
// once: this subcollection is both the bounded evidence-history store
// AND the domain audit trail, so there is exactly one place material
// Discovery mutations are recorded, not two. Survives Lead conversion
// (never deleted, never touched by convertLead beyond appending its own
// "converted" event).
export async function writeLeadEvent(input: WriteLeadEventInput): Promise<void> {
  const event: LeadEvent = {
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = leadEventSchema.parse(event);
  await leadEventsCollection(input.leadUid).doc(randomUUID()).set(parsed);
}

export type LeadEventListCursor = { createdAt: string; id: string };

// Deterministic (newest first, doc id as tiebreak), bounded cursor
// pagination over one Lead's own event history - never a whole-
// subcollection fetch.
export async function listLeadEvents(leadUid: string, options: { limit: number; cursor?: LeadEventListCursor }): Promise<{ events: (LeadEvent & { id: string })[]; nextCursor: LeadEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, 100));

  let query = leadEventsCollection(leadUid).orderBy("createdAt", "desc").orderBy("__name__").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.id);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: (LeadEvent & { id: string })[] = [];
  for (const doc of pageDocs) {
    const result = leadEventSchema.safeParse(doc.data());
    if (result.success) events.push({ ...result.data, id: doc.id });
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { events, nextCursor };
}
