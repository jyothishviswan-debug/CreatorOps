import { z } from "zod";

import { canTransitionLifecycle, CAMPAIGN_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import { getAdminFirestore } from "@/server/firebase/admin";
import type { ActorContext } from "@/server/authz/types";
import { campaignsCollection, getCampaignDocByRef } from "./firestore";
import { evaluateCampaignReadiness } from "./readiness";
import { requireCampaignInScope, requireCampaignsAccess } from "./campaigns-gate";
import { writeCampaignEvent } from "./campaign-events";
import {
  CAMPAIGN_REASON_REQUIRED_STATUSES,
  campaignDocSchema,
  campaignStatusSchema,
  campaignsInvalidInputResult,
  campaignsUnauthorizedResult,
  type CampaignDoc,
  type CampaignStatus,
  type CampaignsServiceResult,
} from "./types";

const transitionInputSchema = z.object({
  to: campaignStatusSchema,
  reason: z.string().min(1).max(1000).optional(),
  expectedVersion: z.number().int().min(1),
});
export type TransitionCampaignInput = z.input<typeof transitionInputSchema>;

type TxResult = { kind: "ok"; doc: CampaignDoc } | { kind: "stale" } | { kind: "not_found" } | { kind: "invalid" };

// The one trusted entry point for every Campaign lifecycle change,
// mirroring Discovery's own transitionLeadLifecycle. Three of the twelve
// canonical edges are action-gated more narrowly than the rest: moving to
// CANCELLED needs `cancel_campaign`, moving to ARCHIVED needs
// `archive_campaign` - both reasoned, both one-way (no restore is ever
// invented). Every other edge shares the ordinary
// `transition_campaign_lifecycle` action. DRAFT -> PLANNED is the one
// edge that recomputes readiness server-side and refuses with a typed
// not_ready result (never a hand-waved pass) if any blocker remains -
// never trusts a client-supplied "it's ready" claim.
export async function transitionCampaignLifecycle(actor: ActorContext | null, campaignRef: unknown, rawInput: unknown, requestId: string): Promise<CampaignsServiceResult<{ version: number; status: CampaignStatus }>> {
  if (!actor) return campaignsUnauthorizedResult("not_authenticated");

  const parsed = transitionInputSchema.safeParse(rawInput);
  if (!parsed.success) return campaignsInvalidInputResult(parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;

  const requiredAction = input.to === "CANCELLED" ? "cancel_campaign" : input.to === "ARCHIVED" ? "archive_campaign" : "transition_campaign_lifecycle";
  const gate = await requireCampaignsAccess(actor, requiredAction);
  if (!gate.ok) return campaignsUnauthorizedResult(gate.reason);

  if (typeof campaignRef !== "string" || campaignRef.length === 0) return campaignsInvalidInputResult("Missing campaignRef.");

  if ((CAMPAIGN_REASON_REQUIRED_STATUSES as readonly CampaignStatus[]).includes(input.to) && !input.reason) {
    return campaignsInvalidInputResult(`A reason is required to move a Campaign to ${input.to}.`);
  }

  const current = await getCampaignDocByRef(campaignRef);
  if (!current) return { ok: false, code: "not_found", message: "Campaign not found." };

  const scopeCheck = await requireCampaignInScope(actor, current);
  if (!scopeCheck.ok) return campaignsUnauthorizedResult(scopeCheck.reason);

  if (!canTransitionLifecycle(current.status, input.to, CAMPAIGN_LIFECYCLE_TRANSITIONS)) {
    return campaignsInvalidInputResult(`Cannot move a Campaign from ${current.status} to ${input.to}.`);
  }

  if (input.to === "PLANNED") {
    const readiness = await evaluateCampaignReadiness(current);
    if (!readiness.ready) {
      return { ok: false, code: "not_ready", message: "This Campaign is not ready to be planned yet.", blockers: readiness.blockers };
    }
  }

  const db = getAdminFirestore();
  const docRef = campaignsCollection().doc(current.uid);

  const result = await db.runTransaction<TxResult>(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return { kind: "not_found" };
    const parsedCurrent = campaignDocSchema.safeParse(snap.data());
    if (!parsedCurrent.success) return { kind: "not_found" };
    const freshCurrent = parsedCurrent.data;

    if (freshCurrent.version !== input.expectedVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(freshCurrent.status, input.to, CAMPAIGN_LIFECYCLE_TRANSITIONS)) return { kind: "invalid" };

    const updated: CampaignDoc = {
      ...freshCurrent,
      status: input.to,
      statusReason: (CAMPAIGN_REASON_REQUIRED_STATUSES as readonly CampaignStatus[]).includes(input.to) ? (input.reason ?? null) : null,
      version: freshCurrent.version + 1,
      updatedAt: new Date().toISOString(),
      updatedByUserRef: actor.userRef,
    };
    tx.set(docRef, updated);
    return { kind: "ok", doc: updated };
  });

  if (result.kind === "not_found") return { ok: false, code: "not_found", message: "Campaign not found." };
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This Campaign was changed elsewhere. Reload and try again." };
  if (result.kind === "invalid") return campaignsInvalidInputResult(`Cannot move a Campaign from ${current.status} to ${input.to}.`);

  const eventKind = input.to === "CANCELLED" ? "cancelled" : input.to === "ARCHIVED" ? "archived" : "lifecycle_transitioned";
  await writeCampaignEvent({ campaignUid: current.uid, kind: eventKind, actorUserRef: actor.userRef, metadata: { from: current.status, to: input.to, reason: input.reason ?? null }, requestId });

  return { ok: true, data: { version: result.doc.version, status: result.doc.status } };
}
