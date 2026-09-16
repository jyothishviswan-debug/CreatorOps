import { z } from "zod";

import { getAdminFirestore } from "@/server/firebase/admin";
import { hasAnotherActiveAdminManager, loadAccessGrant, loadHasGlobalScope, loadOverrideLookup, readerFor, resolvesToAdminManagerCapability } from "@/server/authz/admin-manager-guard";
import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import { writeAuditEvent } from "@/server/authz/audit";
import { COLLECTIONS, getUserDocByRef } from "@/server/authz/firestore";
import { FEATURES, type FeatureId } from "@/server/authz/features";
import { isValidModuleAction } from "@/server/authz/module-actions";
import type { Role } from "@/server/authz/roles";
import type { ActorContext, FeatureOverride, OverrideLookup, UserAccessOverrideDoc } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

const overrideValueSchema = z.enum(["allow", "deny", "inherit"]);
export type OverrideValue = z.infer<typeof overrideValueSchema>;

const setOverrideInputSchema = z.object({
  featureId: z.enum(FEATURES),
  actionId: z.string().min(1).optional(),
  value: overrideValueSchema,
  expectedVersion: z.number().int().min(0),
});
export type SetOverrideInput = z.input<typeof setOverrideInputSchema>;

const bulkOverrideInputSchema = z.object({
  mode: z.enum(["allow_all", "deny_all", "reset_all"]),
  expectedVersion: z.number().int().min(0),
});
export type BulkOverrideInput = z.input<typeof bulkOverrideInputSchema>;

function emptyOverrideDoc(uid: string): UserAccessOverrideDoc {
  return { uid, features: {}, version: 0 };
}

// The mutation base is always a well-formed document to build the next
// state from - both a genuinely absent doc and an existing-but-malformed
// one start a fresh, empty override map at version 0, so this exact
// mutation (however it's applied) becomes the correction write. This is
// deliberately NOT the same thing as "is this actor's override profile
// currently valid" (see loadOverrideLookup below, used separately for
// the admin-manager-capability check) - a malformed doc still has SOME
// version on disk (or doesn't parse enough to know it), so it's never
// safe to silently reuse a stale/unknown version number as if it were 0
// for anything other than this repair path.
function mutationBase(lookup: OverrideLookup, uid: string): UserAccessOverrideDoc {
  return lookup.status === "valid" ? lookup.doc : emptyOverrideDoc(uid);
}

function pruneEmptyFeatures(features: UserAccessOverrideDoc["features"]): UserAccessOverrideDoc["features"] {
  const pruned: UserAccessOverrideDoc["features"] = {};
  for (const [feature, entry] of Object.entries(features) as [FeatureId, FeatureOverride | undefined][]) {
    if (!entry) continue;
    if (entry.view === undefined && Object.keys(entry.actions).length === 0) continue;
    pruned[feature] = entry;
  }
  return pruned;
}

function applyValue(entry: FeatureOverride | undefined, actionId: string | undefined, value: OverrideValue): FeatureOverride {
  const current: FeatureOverride = entry ?? { actions: {} };
  if (actionId) {
    const actions = { ...current.actions };
    if (value === "inherit") delete actions[actionId as keyof typeof actions];
    else actions[actionId as keyof typeof actions] = value === "allow";
    return { ...current, actions };
  }
  if (value === "inherit") {
    const { actions } = current;
    return { actions };
  }
  return { ...current, view: value === "allow" };
}

type MutationOutcome = { kind: "ok"; doc: UserAccessOverrideDoc; before: Record<string, unknown>; after: Record<string, unknown> } | { kind: "stale" } | { kind: "last_admin_manager" };

// Shared by the single-override and bulk mutations: read the target's
// current override doc + role grant + GLOBAL scope, apply `mutate` to get
// the proposed next state, and refuse the write if it would strip the
// target's Administration-manager capability with nobody else able to
// pick it up - all inside the same transaction, reads before writes.
async function runOverrideMutation(
  targetUid: string,
  targetRole: Role,
  targetActive: boolean,
  expectedVersion: number,
  mutate: (current: UserAccessOverrideDoc) => UserAccessOverrideDoc,
): Promise<MutationOutcome> {
  const db = getAdminFirestore();
  const docRef = db.collection(COLLECTIONS.userAccessOverrides).doc(targetUid);

  return db.runTransaction<MutationOutcome>(async (tx) => {
    const reader = readerFor(tx);
    const currentLookup = await loadOverrideLookup(reader, targetUid);
    const current = mutationBase(currentLookup, targetUid);
    if (current.version !== expectedVersion) return { kind: "stale" };

    const next = mutate(current);
    const nextPruned: UserAccessOverrideDoc = { uid: targetUid, features: pruneEmptyFeatures(next.features), version: current.version + 1 };

    const [accessGrant, hasGlobalScope] = await Promise.all([loadAccessGrant(reader, targetRole), loadHasGlobalScope(reader, targetUid)]);
    // Deliberately uses the TRUE current status (absent/valid/invalid),
    // not the normalized mutation base above - if the target's override
    // doc is currently malformed, they already fail closed to no
    // Administration capability (see resolveFeatureAccess), so this
    // exact corrective write must never be blocked as "the last admin
    // manager": there is no working capability to protect, and this is
    // the repair path.
    const hadCapability = resolvesToAdminManagerCapability({ active: targetActive, accessGrant, override: currentLookup, hasGlobalScope });
    const wouldStillHaveCapability = resolvesToAdminManagerCapability({ active: targetActive, accessGrant, override: { status: "valid", doc: nextPruned }, hasGlobalScope });

    if (hadCapability && !wouldStillHaveCapability) {
      const another = await hasAnotherActiveAdminManager(targetUid, tx);
      if (!another) return { kind: "last_admin_manager" };
    }

    tx.set(docRef, nextPruned);
    return { kind: "ok", doc: nextPruned, before: current.features, after: nextPruned.features };
  });
}

export async function setAccessOverride(actor: ActorContext | null, userRef: unknown, rawInput: unknown, requestId: string): Promise<ServiceResult<{ version: number }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_overrides");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");
  const parsed = setOverrideInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.actionId && !isValidModuleAction(input.featureId, input.actionId)) {
    return invalidInputResult(`"${input.actionId}" is not a valid action for this module.`);
  }

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const outcome = await runOverrideMutation(targetDoc.uid, targetDoc.role, targetDoc.active, input.expectedVersion, (current) => ({
    ...current,
    features: { ...current.features, [input.featureId]: applyValue(current.features[input.featureId], input.actionId, input.value) },
  }));

  if (outcome.kind === "stale") return { ok: false, code: "stale_write", message: "This user's access overrides were changed elsewhere. Reload and try again." };
  if (outcome.kind === "last_admin_manager") {
    return { ok: false, code: "conflict", message: "Refusing to change this user: they are the last active user who can fully administer users and access." };
  }

  await writeAuditEvent({
    operation: "access_override.set",
    actor,
    actorUserRef: actor.userRef,
    target: { uid: targetDoc.uid, userRef: targetDoc.userRef, email: targetDoc.email },
    targetRole: targetDoc.role,
    before: { [input.featureId]: outcome.before[input.featureId] ?? null },
    after: { [input.featureId]: outcome.after[input.featureId] ?? null, actionId: input.actionId ?? null, value: input.value },
    requestId,
  });

  return { ok: true, data: { version: outcome.doc.version } };
}

export async function bulkSetAccessOverrides(actor: ActorContext | null, userRef: unknown, rawInput: unknown, requestId: string): Promise<ServiceResult<{ version: number }>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_overrides");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");
  const parsed = bulkOverrideInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const mutate = (current: UserAccessOverrideDoc): UserAccessOverrideDoc => {
    if (input.mode === "reset_all") return { uid: current.uid, features: {}, version: current.version };
    // Allow All / Deny All only sets each module's own view override -
    // any existing action-level overrides for that module are preserved
    // (a module denial makes them moot for now, per the effective-access
    // algorithm, but doesn't discard the admin's prior, more specific
    // choices).
    const view = input.mode === "allow_all";
    const features: UserAccessOverrideDoc["features"] = {};
    for (const feature of FEATURES) features[feature] = { ...current.features[feature], view, actions: current.features[feature]?.actions ?? {} };
    return { uid: current.uid, features, version: current.version };
  };

  const outcome = await runOverrideMutation(targetDoc.uid, targetDoc.role, targetDoc.active, input.expectedVersion, mutate);

  if (outcome.kind === "stale") return { ok: false, code: "stale_write", message: "This user's access overrides were changed elsewhere. Reload and try again." };
  if (outcome.kind === "last_admin_manager") {
    return { ok: false, code: "conflict", message: "Refusing to apply this bulk change: it would leave nobody able to fully administer users and access." };
  }

  await writeAuditEvent({
    operation: "access_override.set",
    actor,
    actorUserRef: actor.userRef,
    target: { uid: targetDoc.uid, userRef: targetDoc.userRef, email: targetDoc.email },
    targetRole: targetDoc.role,
    before: { mode: "bulk", moduleCount: Object.keys(outcome.before).length },
    after: { mode: input.mode, moduleCount: Object.keys(outcome.after).length },
    requestId,
  });

  return { ok: true, data: { version: outcome.doc.version } };
}
