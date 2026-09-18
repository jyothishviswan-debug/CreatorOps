import { randomUUID } from "node:crypto";

import { assignmentEventsCollection } from "./firestore";
import { assignmentEventSchema, type AssignmentEvent, type AssignmentEventKind } from "./types";

// Same defense-in-depth redaction discipline as Campaigns'/Vendors'/
// Partners' own events modules. Assignment never handles restricted
// identity or Finance values, but this list is kept at least as wide as
// Campaign's own (which already defensively includes "amount"/"rate")
// since Assignment sits one step closer to the future external-submission
// surface - a caller mistake here must never leak a token, secret, or
// financial value into this durable, append-only collection.
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

export type WriteAssignmentEventInput = {
  assignmentUid: string;
  kind: AssignmentEventKind;
  actorUserRef: string;
  metadata: Record<string, unknown> | null;
  requestId: string;
};

// The append-only per-Assignment event/audit history - same pattern as
// Campaigns'/Vendors'/Partners' own event modules. Never deleted, never
// rewritten.
export async function writeAssignmentEvent(input: WriteAssignmentEventInput): Promise<void> {
  const event: AssignmentEvent = {
    kind: input.kind,
    actorUserRef: input.actorUserRef,
    metadata: redact(input.metadata),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = assignmentEventSchema.parse(event);
  await assignmentEventsCollection(input.assignmentUid).doc(randomUUID()).set(parsed);
}

export type AssignmentEventListCursor = { createdAt: string; id: string };

// Deterministic (newest first, doc id as tiebreak), bounded cursor
// pagination over one Assignment's own event history - never a whole-
// subcollection fetch.
export async function listAssignmentEvents(
  assignmentUid: string,
  options: { limit: number; cursor?: AssignmentEventListCursor },
): Promise<{ events: (AssignmentEvent & { id: string })[]; nextCursor: AssignmentEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, 100));

  let query = assignmentEventsCollection(assignmentUid).orderBy("createdAt", "desc").orderBy("__name__").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.id);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: (AssignmentEvent & { id: string })[] = [];
  for (const doc of pageDocs) {
    const result = assignmentEventSchema.safeParse(doc.data());
    if (result.success) events.push({ ...result.data, id: doc.id });
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { events, nextCursor };
}
