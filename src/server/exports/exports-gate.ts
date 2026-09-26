import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { FeatureId } from "@/server/authz/features";
import type { ActorContext } from "@/server/authz/types";

import type { ExportsDenialReason } from "./types";

// The Export Center gate. Mirrors src/server/reports/reports-gate.ts's own chain exactly -
// Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(exports) ->
// ActionPermission(create_exports) -> (per-target) FeatureAccess of the source module the target
// reads through. Explicit grants only: no role rank, no wildcard, no minimumRole, and a missing
// grant fails closed.
export type ExportsAction = "create_exports";
export type ExportsAccessResult = { ok: true } | { ok: false; reason: ExportsDenialReason };

export async function requireExportsAccess(actor: ActorContext | null, action?: ExportsAction): Promise<ExportsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "exports");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };
  if (action) {
    const hasAction = await canPerformAction(actor, "exports", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }
  return { ok: true };
}

// Before composing a target, the actor must already hold real FeatureAccess to the source module
// the target declares (ExportTargetDefinition.requiredSourceFeatures) - Export Center never grants
// visibility into a module the actor could not already see directly.
export async function requireSourceFeatureAccess(actor: ActorContext, requiredSourceFeatures: FeatureId[]): Promise<ExportsAccessResult> {
  for (const feature of requiredSourceFeatures) {
    const allowed = await canAccessFeature(actor, feature);
    if (!allowed) return { ok: false, reason: "scope_denied" };
  }
  return { ok: true };
}
