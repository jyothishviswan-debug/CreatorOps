import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import { writeAuditEvent } from "@/server/authz/audit";
import { COLLECTIONS, getSensitiveAccessGrantDoc } from "@/server/authz/firestore";
import type { Role } from "@/server/authz/roles";
import { roleSchema, type ActorContext, type SensitiveAccessGrantDoc } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

// Sensitive Access is role-keyed in the existing canonical model (Step
// 4B) - one document per role, not per user. This service manages that
// same sensitiveAccessGrants/{role} document; it does not introduce a
// second, user-level sensitive-grant concept.
const categoryInputSchema = z.object({ category: z.string().min(1) });

export type SensitiveGrantRequestInput = z.input<typeof categoryInputSchema>;

export async function getSensitiveGrants(actor: ActorContext | null, rawRole: unknown): Promise<ServiceResult<{ role: Role; categories: string[] }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_sensitive");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  const parsedRole = roleSchema.safeParse(rawRole);
  if (!parsedRole.success) return invalidInputResult("Invalid role.");

  const doc = await getSensitiveAccessGrantDoc(parsedRole.data);
  return { ok: true, data: { role: parsedRole.data, categories: doc?.categories ?? [] } };
}

export async function addSensitiveGrant(actor: ActorContext | null, rawRole: unknown, rawInput: unknown, requestId: string): Promise<ServiceResult<{ categories: string[] }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_sensitive");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  const parsedRole = roleSchema.safeParse(rawRole);
  if (!parsedRole.success) return invalidInputResult("Invalid role.");
  const role = parsedRole.data;

  const parsedInput = categoryInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return invalidInputResult(parsedInput.error.issues.map((issue) => issue.message).join("; "));
  const { category } = parsedInput.data;

  const db = getAdminFirestore();
  const docRef = db.collection(COLLECTIONS.sensitiveAccessGrants).doc(role);

  const before = (await getSensitiveAccessGrantDoc(role))?.categories ?? [];
  const after = before.includes(category) ? before : [...before, category];

  const doc: SensitiveAccessGrantDoc = { role, categories: after };
  await docRef.set(doc);

  await writeAuditEvent({
    operation: "sensitive_grant.add",
    actor,
    actorUserRef: actor.userRef,
    targetRole: role,
    before: { categories: before },
    after: { categories: after },
    requestId,
  });

  return { ok: true, data: { categories: after } };
}

export async function removeSensitiveGrant(actor: ActorContext | null, rawRole: unknown, rawInput: unknown, requestId: string): Promise<ServiceResult<{ categories: string[] }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_sensitive");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  const parsedRole = roleSchema.safeParse(rawRole);
  if (!parsedRole.success) return invalidInputResult("Invalid role.");
  const role = parsedRole.data;

  const parsedInput = categoryInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return invalidInputResult(parsedInput.error.issues.map((issue) => issue.message).join("; "));
  const { category } = parsedInput.data;

  const before = (await getSensitiveAccessGrantDoc(role))?.categories ?? [];
  if (!before.includes(category)) return { ok: false, code: "not_found", message: "Category not granted." };
  const after = before.filter((existing) => existing !== category);

  const db = getAdminFirestore();
  const doc: SensitiveAccessGrantDoc = { role, categories: after };
  await db.collection(COLLECTIONS.sensitiveAccessGrants).doc(role).set(doc);

  await writeAuditEvent({
    operation: "sensitive_grant.remove",
    actor,
    actorUserRef: actor.userRef,
    targetRole: role,
    before: { categories: before },
    after: { categories: after },
    requestId,
  });

  return { ok: true, data: { categories: after } };
}
