import { randomUUID } from "node:crypto";

import { contentEventsCollection } from "./firestore";
import { contentEventSchema, type ContentEvent, type ContentEventKind } from "./types";

// Same defense-in-depth redaction discipline as Assignments'/Campaigns'/
// Vendors'/Partners' own events modules. Content never handles Finance
// values directly, but review decisions and publication evidence flow
// through this collection's metadata, so the list stays at least as wide
// as Assignment's own.
const FORBIDDEN_METADATA_KEY_SUBSTRINGS = [
  "password",
  "token",
  "secret",
  "credential",
  "cookie",
  "pan",
  "bank",
  "ifsc",
  "iban",
  "account_number",
  "accountnumber",
  "gst",
  "amount",
  "rate",
];

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

export type WriteContentEventInput = {
  contentUid: string;
  kind: ContentEventKind;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
};

// The append-only per-Content event/audit history - review decisions fold
// in here as a "review_decision" event kind rather than a second
// dedicated collection (Step 11A section 5's own either/or - this build
// picks the append-only-event shape). Never deleted, never rewritten.
export async function writeContentEvent(input: WriteContentEventInput): Promise<void> {
  const event: ContentEvent = {
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = contentEventSchema.parse(event);
  await contentEventsCollection(input.contentUid).doc(randomUUID()).set(parsed);
}

export type ContentEventListCursor = { createdAt: string; id: string };

// Deterministic (newest first, doc id as tiebreak), bounded cursor
// pagination over one Content record's own event history - never a
// whole-subcollection fetch.
export async function listContentEvents(
  contentUid: string,
  options: { limit: number; cursor?: ContentEventListCursor },
): Promise<{ events: (ContentEvent & { id: string })[]; nextCursor: ContentEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, 100));

  let query = contentEventsCollection(contentUid).orderBy("createdAt", "desc").orderBy("__name__").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.id);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: (ContentEvent & { id: string })[] = [];
  for (const doc of pageDocs) {
    const result = contentEventSchema.safeParse(doc.data());
    if (result.success) events.push({ ...result.data, id: doc.id });
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { events, nextCursor };
}
