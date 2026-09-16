import { z } from "zod";

import { canTransitionLifecycle, LEAD_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { requireDiscoveryAccess, requireLeadInScope } from "./discovery-gate";
import { getLeadDocByRef, leadsCollection } from "./firestore";
import { writeLeadEvent } from "./lead-events";
import { evaluateLeadReadiness } from "./readiness";
import { leadDocSchema, leadLifecycleSchema, LEAD_RESTORABLE_STATES, type DiscoveryServiceResult, type LeadDoc, type LeadLifecycle } from "./types";
import { discoveryInvalidInputResult, discoveryUnauthorizedResult } from "./types";

const REASON_REQUIRED_TARGETS: readonly LeadLifecycle[] = ["WATCHLIST", "REJECTED", "ARCHIVED", "DUPLICATE"];

const transitionInputSchema = z.object({
  to: leadLifecycleSchema,
  reason: z.string().min(1).max(1000).optional(),
  expectedVersion: z.number().int().min(1),
});
export type TransitionLeadInput = z.input<typeof transitionInputSchema>;

type TxResult = { kind: "ok"; doc: LeadDoc } | { kind: "stale" } | { kind: "not_found" } | { kind: "invalid" };

// Step 6A: the single trusted entry point for every MANUAL lifecycle
// change (moving along the main path, or setting a Lead aside into
// WATCHLIST/REJECTED/ARCHIVED/DUPLICATE with a reason). CONVERTED is
// deliberately rejected here - it is only ever set by convertLead's own
// transaction. Entering CONVERSION_READY specifically re-runs the one
// shared canonical readiness function and is refused if any blocker
// remains, so "conversion-ready" can never be hand-waved past what
// readiness actually says.
export async function transitionLeadLifecycle(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<{ version: number; lifecycle: LeadLifecycle }>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryAccess(actor, "transition_lifecycle");
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  if (typeof leadRef !== "string" || leadRef.length === 0) return discoveryInvalidInputResult("Missing leadRef.");
  const parsed = transitionInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  if (input.to === "CONVERTED") return discoveryInvalidInputResult("CONVERTED is only ever reached through the dedicated conversion flow.");
  if (REASON_REQUIRED_TARGETS.includes(input.to) && !input.reason) {
    return discoveryInvalidInputResult(`A reason is required to move a Lead to ${input.to}.`);
  }

  const current = await getLeadDocByRef(leadRef);
  if (!current) return { ok: false, code: "not_found", message: "Lead not found." };

  const scopeCheck = await requireLeadInScope(actor, current);
  if (!scopeCheck.ok) return discoveryUnauthorizedResult(scopeCheck.reason);

  if (!canTransitionLifecycle(current.lifecycle, input.to, LEAD_LIFECYCLE_TRANSITIONS)) {
    return discoveryInvalidInputResult(`Cannot move a Lead from ${current.lifecycle} to ${input.to}.`);
  }

  if (input.to === "CONVERSION_READY") {
    const readiness = await evaluateLeadReadiness(current);
    if (!readiness.ready) {
      return { ok: false, code: "not_ready", message: "This Lead is not ready for conversion yet.", blockers: readiness.blockers };
    }
  }

  const db = getAdminFirestore();
  const docRef = leadsCollection().doc(current.uid);

  const result = await db.runTransaction<TxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = leadDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const freshCurrent = parsedCurrent.data;

    if (freshCurrent.version !== input.expectedVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(freshCurrent.lifecycle, input.to, LEAD_LIFECYCLE_TRANSITIONS)) return { kind: "invalid" };

    const enteringRestorable = LEAD_RESTORABLE_STATES.includes(input.to);
    const updated: LeadDoc = {
      ...freshCurrent,
      lifecycle: input.to,
      previousLifecycle: enteringRestorable ? freshCurrent.lifecycle : freshCurrent.previousLifecycle,
      lifecycleReason: input.reason ?? null,
      version: freshCurrent.version + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserRef: actor.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return discoveryInvalidInputResult(`Cannot move a Lead from ${current.lifecycle} to ${input.to}.`);

  await writeLeadEvent({
    leadUid: current.uid,
    kind: "lifecycle_transitioned",
    actorUserRef: actor.userRef,
    metadata: { from: current.lifecycle, to: input.to, reason: input.reason ?? null },
    requestId,
  });

  return { ok: true, data: { version: result.doc.version, lifecycle: result.doc.lifecycle } };
}

const restoreInputSchema = z.object({
  reason: z.string().min(1).max(1000),
  expectedVersion: z.number().int().min(1),
});
export type RestoreLeadInput = z.input<typeof restoreInputSchema>;

// Reasoned, authorized restore/reactivation out of
// WATCHLIST/REJECTED/ARCHIVED - the target is the Lead's OWN recorded
// previousLifecycle (dynamic, not a static table entry), which is why
// this is its own function rather than a call into
// transitionLeadLifecycle. DUPLICATE has no restore path at all
// (terminal).
export async function restoreLead(actor: ActorContext | null, leadRef: unknown, rawInput: unknown, requestId: string): Promise<DiscoveryServiceResult<{ version: number; lifecycle: LeadLifecycle }>> {
  if (!actor) return discoveryUnauthorizedResult("not_authenticated");
  const gate = await requireDiscoveryAccess(actor, "transition_lifecycle");
  if (!gate.ok) return discoveryUnauthorizedResult(gate.reason);

  if (typeof leadRef !== "string" || leadRef.length === 0) return discoveryInvalidInputResult("Missing leadRef.");
  const parsed = restoreInputSchema.safeParse(rawInput);
  if (!parsed.success) return discoveryInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const current = await getLeadDocByRef(leadRef);
  if (!current) return { ok: false, code: "not_found", message: "Lead not found." };

  const scopeCheck = await requireLeadInScope(actor, current);
  if (!scopeCheck.ok) return discoveryUnauthorizedResult(scopeCheck.reason);

  if (!LEAD_RESTORABLE_STATES.includes(current.lifecycle)) {
    return discoveryInvalidInputResult(`A Lead in ${current.lifecycle} cannot be restored.`);
  }
  if (!current.previousLifecycle) {
    return { ok: false, code: "internal", message: "This Lead has no recorded prior state to restore to." };
  }

  const db = getAdminFirestore();
  const docRef = leadsCollection().doc(current.uid);

  const result = await db.runTransaction<TxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = leadDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const freshCurrent = parsedCurrent.data;

    if (freshCurrent.version !== input.expectedVersion) return { kind: "stale" };
    if (!LEAD_RESTORABLE_STATES.includes(freshCurrent.lifecycle) || !freshCurrent.previousLifecycle) return { kind: "invalid" };

    const updated: LeadDoc = {
      ...freshCurrent,
      lifecycle: freshCurrent.previousLifecycle,
      previousLifecycle: null,
      lifecycleReason: input.reason,
      version: freshCurrent.version + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserRef: actor.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Lead not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Lead was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return discoveryInvalidInputResult("This Lead can no longer be restored.");

  await writeLeadEvent({
    leadUid: current.uid,
    kind: "lifecycle_restored",
    actorUserRef: actor.userRef,
    metadata: { from: current.lifecycle, to: result.doc.lifecycle, reason: input.reason },
    requestId,
  });

  return { ok: true, data: { version: result.doc.version, lifecycle: result.doc.lifecycle } };
}
