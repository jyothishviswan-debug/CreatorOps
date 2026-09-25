import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { FeatureId } from "@/server/authz/features";
import type { ActorContext } from "@/server/authz/types";

import type { ReportsDenialReason } from "./types";

// Step 19A: the Reports gate. Mirrors src/server/operations/operations-gate.ts's own chain -
// Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(reports) ->
// ActionPermission -> (per-report) FeatureAccess of every source module the report reads through.
// Explicit grants only: no role rank, no wildcard, no minimumRole, and a missing grant fails closed.
//
// Section 17 (the Viewer boundary): a plain "reports" FeatureAccess grant (view:true, already held by
// Viewer/Analyst/Partnership Manager/Partnership Head per seed-access-data.ts) is enough to call the
// VIEWER-SAFE run path (requireReportsAccess with no `action`) - it never requires the run_reports
// ActionPermission. The full/regular run path additionally requires run_reports (`action:
// "run_reports"` below), which Viewer's role baseline deliberately does NOT hold (see
// seed-access-data.ts's own comment on why) - so Viewer is sanctioned for the safer, restricted
// surface only. This is a REAL, distinct, testable authorization boundary, not a naming convention.
export type ReportsAction = "run_reports" | "export";
export type ReportsAccessResult = { ok: true } | { ok: false; reason: ReportsDenialReason };

export async function requireReportsAccess(actor: ActorContext | null, action?: ReportsAction): Promise<ReportsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "reports");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };
  if (action) {
    const hasAction = await canPerformAction(actor, "reports", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }
  return { ok: true };
}

// Section 8/11: before composing a report family, the actor must already hold real FeatureAccess to
// EVERY source module that family declares (ReportDefinition.requiredSourceFeatures) - Reports never
// grants visibility into a module the actor could not already see directly, and never re-implements
// that module's own gate to decide it. A missing grant on ANY declared source feature denies the
// whole report up front (scope_denied) rather than silently composing a partial result from only the
// sources the actor happens to hold - see report-service.ts's runReport.
export async function requireSourceFeatureAccess(actor: ActorContext, requiredSourceFeatures: FeatureId[]): Promise<ReportsAccessResult> {
  for (const feature of requiredSourceFeatures) {
    const allowed = await canAccessFeature(actor, feature);
    if (!allowed) return { ok: false, reason: "scope_denied" };
  }
  return { ok: true };
}
