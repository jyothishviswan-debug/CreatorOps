import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";
import type { AnalyticsDenialReason } from "./types";

// Step 12A section 17-18: fails closed everywhere, same shape as every
// other domain's requireXAccess gate (Content's requireContentAccess/
// requireContentFeatureAccess). Analytics is split into two genuinely
// separate action permissions - "explore" (read/browse via the Data
// Explorer and live scoped read-model queries) and
// "manage_analytics_data" (import/correction operations) - proven
// separately gated by analytics.emulator.test.ts (a role can hold one
// without the other, e.g. Partnership Manager: explore true,
// manage_analytics_data false by default).
export type AnalyticsAccessResult = { ok: true } | { ok: false; reason: AnalyticsDenialReason };

export async function requireAnalyticsFeatureAccess(actor: ActorContext | null): Promise<AnalyticsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "analytics");
  return hasFeature ? { ok: true } : { ok: false, reason: "feature_denied" };
}

export async function requireAnalyticsExploreAccess(actor: ActorContext | null): Promise<AnalyticsAccessResult> {
  const feature = await requireAnalyticsFeatureAccess(actor);
  if (!feature.ok) return feature;
  const hasAction = await canPerformAction(actor!, "analytics", "explore");
  return hasAction ? { ok: true } : { ok: false, reason: "action_denied" };
}

export async function requireAnalyticsManageAccess(actor: ActorContext | null): Promise<AnalyticsAccessResult> {
  const feature = await requireAnalyticsFeatureAccess(actor);
  if (!feature.ok) return feature;
  const hasAction = await canPerformAction(actor!, "analytics", "manage_analytics_data");
  return hasAction ? { ok: true } : { ok: false, reason: "action_denied" };
}

// Import Center MODULE access, deliberately separate from the
// target-specific action check above - see the task's own "prove module
// access and target action access are separately tested" requirement.
// This gates "can this actor use Import Center at all, for ANY target";
// requireAnalyticsManageAccess gates "can this actor operate the
// Analytics target specifically". Both must pass for an Analytics
// dry-run/execute to succeed (see import-service.ts).
export async function requireImportsModuleAccess(actor: ActorContext | null): Promise<AnalyticsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "imports");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };
  const hasAction = await canPerformAction(actor, "imports", "manage_imports");
  return hasAction ? { ok: true } : { ok: false, reason: "action_denied" };
}
