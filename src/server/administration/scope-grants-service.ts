import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import { writeAuditEvent } from "@/server/authz/audit";
import { COLLECTIONS, getUserDocByRef } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant, ScopeGrantInput } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

// Mirrors the ScopeGrant discriminated union (types.ts) minus the audit
// fields - exactly what a caller supplies to create a grant. The server
// fills in uid/grantedAt/grantedBy; a client can never set those itself.
const scopeGrantInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SELF") }),
  z.object({ type: z.literal("GLOBAL") }),
  z.object({ type: z.literal("REGION"), region: z.string().min(1) }),
  z.object({ type: z.literal("TEAM"), teamId: z.string().min(1) }),
  z.object({ type: z.literal("PARTNER"), partnerId: z.string().min(1) }),
  z.object({ type: z.literal("CAMPAIGN"), campaignId: z.string().min(1) }),
  z.object({ type: z.literal("EXPLICIT_RECORD"), resourceType: z.string().min(1), resourceId: z.string().min(1) }),
  z.object({ type: z.literal("ANALYTICS_DATASET"), datasetId: z.string().min(1) }),
  z.object({ type: z.literal("ANALYTICS_ACCOUNT"), accountId: z.string().min(1) }),
]);

export type ScopeGrantRequestInput = z.input<typeof scopeGrantInputSchema>;

// The stored ScopeGrant document carries `uid`/`grantedBy` - real Firebase
// uids - alongside the type/discriminator fields. Audit metadata must never
// include those (see audit.ts's redact(), which only catches
// password/token/secret-shaped keys, not this), so the raw document is
// never logged as-is; only its safe, presentation-shaped fields are.
function toSafeGrantMetadata(grant: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...grant };
  delete safe.uid;
  delete safe.grantedBy;
  return safe;
}

// Add is idempotent (same deterministic doc id, a repeat call just
// overwrites with a fresh grantedAt/grantedBy) - "created" distinguishes
// a genuinely new grant from a no-op re-grant of one that already existed,
// for a caller that wants to know.
export async function addScopeGrant(
  actor: ActorContext | null,
  userRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<ServiceResult<{ created: boolean }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_scope");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");

  const parsed = scopeGrantInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const grantInput: ScopeGrantInput = parsed.data;

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const db = getAdminFirestore();
  const docId = scopeGrantDocId(targetDoc.uid, grantInput);
  const docRef = db.collection(COLLECTIONS.scopeAssignments).doc(docId);

  const existing = await docRef.get();
  const grant: ScopeGrant = { ...grantInput, uid: targetDoc.uid, grantedAt: new Date().toISOString(), grantedBy: actor.uid } as ScopeGrant;
  await docRef.set(grant);

  await writeAuditEvent({
    operation: "scope_grant.add",
    actor,
    actorUserRef: actor.userRef,
    target: { uid: targetDoc.uid, userRef: targetDoc.userRef, email: targetDoc.email },
    before: existing.exists ? toSafeGrantMetadata(existing.data() as Record<string, unknown>) : null,
    after: grantInput,
    requestId,
  });

  return { ok: true, data: { created: !existing.exists } };
}

export async function removeScopeGrant(
  actor: ActorContext | null,
  userRef: unknown,
  rawInput: unknown,
  requestId: string,
): Promise<ServiceResult<{ removed: boolean }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_scope");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");

  const parsed = scopeGrantInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const grantInput: ScopeGrantInput = parsed.data;

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const db = getAdminFirestore();
  const docId = scopeGrantDocId(targetDoc.uid, grantInput);
  const docRef = db.collection(COLLECTIONS.scopeAssignments).doc(docId);

  const existing = await docRef.get();
  if (!existing.exists) return { ok: false, code: "not_found", message: "Grant not found." };

  await docRef.delete();

  await writeAuditEvent({
    operation: "scope_grant.remove",
    actor,
    actorUserRef: actor.userRef,
    target: { uid: targetDoc.uid, userRef: targetDoc.userRef, email: targetDoc.email },
    before: toSafeGrantMetadata(existing.data() as Record<string, unknown>),
    after: null,
    requestId,
  });

  return { ok: true, data: { removed: true } };
}
