import { randomUUID } from "node:crypto";

import { partnerEventsCollection } from "./firestore";
import { partnerEventSchema, type PartnerEvent, type PartnerEventKind } from "./types";

// Same defense-in-depth redaction discipline as Discovery's
// lead-events.ts - even though restricted-identity-service.ts never
// passes raw values into event metadata in the first place, a future
// mistake in a caller still can't leak a PAN/Aadhaar/bank value into this
// durable, append-only collection.
const FORBIDDEN_METADATA_KEY_SUBSTRINGS = ["password", "token", "secret", "credential", "cookie", "aadhaar", "pan", "bank", "ifsc", "iban", "account_number", "accountnumber", "gst"];

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

export type WritePartnerEventInput = {
  partnerUid: string;
  kind: PartnerEventKind;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
};

// The append-only per-Partner event/audit history - Discovery's
// lead-events.ts pattern, one collection serving both "bounded evidence
// history" and "domain audit trail" at once. Survives blacklist/archive/
// restore (never deleted, never rewritten - a governance transition only
// ever appends its own event).
export async function writePartnerEvent(input: WritePartnerEventInput): Promise<void> {
  const event: PartnerEvent = {
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = partnerEventSchema.parse(event);
  await partnerEventsCollection(input.partnerUid).doc(randomUUID()).set(parsed);
}

export type PartnerEventListCursor = { createdAt: string; id: string };

// Deterministic (newest first, doc id as tiebreak), bounded cursor
// pagination over one Partner's own event history - never a whole-
// subcollection fetch.
export async function listPartnerEvents(partnerUid: string, options: { limit: number; cursor?: PartnerEventListCursor }): Promise<{ events: (PartnerEvent & { id: string })[]; nextCursor: PartnerEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, 100));

  let query = partnerEventsCollection(partnerUid).orderBy("createdAt", "desc").orderBy("__name__").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.id);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: (PartnerEvent & { id: string })[] = [];
  for (const doc of pageDocs) {
    const result = partnerEventSchema.safeParse(doc.data());
    if (result.success) events.push({ ...result.data, id: doc.id });
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { events, nextCursor };
}
