import { randomUUID } from "node:crypto";

import { getAdminFirestore } from "@/server/firebase/admin";
import { COLLECTIONS, MAX_LIST_PAGE_SIZE } from "./firestore";
import type { Role } from "./roles";
import { auditEventSchema, type ActorContext, type AuditEvent, type AuditOperation } from "./types";

const FORBIDDEN_METADATA_KEY_SUBSTRINGS = ["password", "token", "secret", "credential", "cookie"];

// Defense in depth: even though callers should never put a secret in
// audit metadata in the first place, strip any key that *looks* like one
// before it's ever written, so a future mistake in a caller can't leak a
// credential into a durable, long-lived collection.
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

export type WriteAuditEventInput = {
  operation: AuditOperation;
  actor: ActorContext;
  actorUserRef: string;
  target?: { uid: string; userRef: string; email: string };
  targetRole?: Role;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string;
};

// Every access-changing Administration mutation calls this - never
// optional, never best-effort. Parsing with the strict schema before
// writing means a caller mistake (a missing field, a wrong type) throws
// instead of silently persisting a malformed audit record - fail closed
// applies to the audit trail itself, not just to access decisions.
export async function writeAuditEvent(input: WriteAuditEventInput): Promise<void> {
  // The optional target*/targetRole fields must be omitted entirely when
  // absent, not set to `undefined` - the real Firestore Admin SDK rejects
  // any field whose value is literally `undefined` (mocked unit tests
  // never catch this, since a mock's `set()` doesn't validate).
  const event: AuditEvent = {
    operation: input.operation,
    actorUid: input.actor.uid,
    actorUserRef: input.actorUserRef,
    actorEmail: input.actor.email,
    ...(input.target ? { targetUid: input.target.uid, targetUserRef: input.target.userRef, targetEmail: input.target.email } : {}),
    ...(input.targetRole !== undefined ? { targetRole: input.targetRole } : {}),
    before: redact(input.before),
    after: redact(input.after),
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
  const parsed = auditEventSchema.parse(event);
  await getAdminFirestore().collection(COLLECTIONS.auditEvents).doc(randomUUID()).set(parsed);
}

export type AuditEventListCursor = { createdAt: string; requestId: string };

// Deterministic (newest first, requestId as tiebreak), bounded cursor
// pagination - same shape as listUserDocs in firestore.ts.
export async function listAuditEvents(options: {
  limit: number;
  cursor?: AuditEventListCursor;
}): Promise<{ events: AuditEvent[]; nextCursor: AuditEventListCursor | null }> {
  const pageSize = Math.max(1, Math.min(options.limit, MAX_LIST_PAGE_SIZE));

  let query = getAdminFirestore().collection(COLLECTIONS.auditEvents).orderBy("createdAt", "desc").orderBy("requestId").limit(pageSize + 1);
  if (options.cursor) query = query.startAfter(options.cursor.createdAt, options.cursor.requestId);

  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;

  const events: AuditEvent[] = [];
  for (const doc of pageDocs) {
    const result = auditEventSchema.safeParse(doc.data());
    if (result.success) events.push(result.data);
  }

  const last = events[events.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, requestId: last.requestId } : null;

  return { events, nextCursor };
}
