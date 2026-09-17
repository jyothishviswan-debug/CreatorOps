import { randomUUID } from "node:crypto";

import { vendorEventsCollection } from "./firestore";
import { vendorEventSchema, type VendorEvent, type VendorEventKind } from "./types";

// Same defense-in-depth redaction discipline as Partners' own
// partner-events.ts - even though restricted-identity-service.ts never
// passes raw values into event metadata in the first place, a future
// mistake in a caller still can't leak a PAN/GST/bank value into this
// durable, append-only collection.
const FORBIDDEN_METADATA_KEY_SUBSTRINGS = ["password", "token", "secret", "credential", "cookie", "pan", "bank", "ifsc", "iban", "account_number", "accountnumber", "gst"];

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

export type WriteVendorEventInput = {
  vendorUid: string;
  kind: VendorEventKind;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
};

// The append-only per-Vendor event/audit history - Partners' own
// partner-events.ts pattern, one collection serving both "bounded
// evidence history" and "domain audit trail" at once, covering both
// Vendor-level changes and every relationship (link) change this Vendor
// was party to. Survives archive/restore (never deleted, never
// rewritten - a governance transition only ever appends its own event).
export async function writeVendorEvent(input: WriteVendorEventInput): Promise<void> {
  const event: VendorEvent = {
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = vendorEventSchema.parse(event);
  await vendorEventsCollection(input.vendorUid).doc(randomUUID()).set(parsed);
}

export type VendorEventListCursor = { createdAt: string; id: string };

// Deterministic (newest first, doc id as tiebreak), bounded cursor
// pagination over one Vendor's own event history - never a whole-
// subcollection fetch.
export async function listVendorEvents(vendorUid: string, options: { limit: number; cursor?: VendorEventListCursor }): Promise<{ events: (VendorEvent & { id: string })[]; nextCursor: VendorEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, 100));

  let query = vendorEventsCollection(vendorUid).orderBy("createdAt", "desc").orderBy("__name__").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.id);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: (VendorEvent & { id: string })[] = [];
  for (const doc of pageDocs) {
    const result = vendorEventSchema.safeParse(doc.data());
    if (result.success) events.push({ ...result.data, id: doc.id });
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { events, nextCursor };
}
