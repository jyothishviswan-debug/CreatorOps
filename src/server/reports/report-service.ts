import type { ActorContext } from "@/server/authz/types";

import { getReportDefinition, listReportDefinitions } from "./catalog";
import { runAdministrationSecurityReport } from "./families/administration-security";
import { runCampaignDeliveryReport } from "./families/campaign-delivery";
import { runCampaignEventPerformanceReport } from "./families/campaign-event-performance";
import { runCampaignPerformanceReport } from "./families/campaign-performance";
import { runChannelGrowthFreshnessReport } from "./families/channel-growth-freshness";
import { runCrossPlatformPartnerProgrammeReport } from "./families/cross-platform-partner-programme";
import { runDiscoveryFunnelReport } from "./families/discovery-funnel";
import { runFinanceStatusReport } from "./families/finance-status";
import { runLongPeriodPartnerProgrammeReport } from "./families/long-period-partner-programme";
import { runMonthlyPartnerPerformanceReport } from "./families/monthly-partner-performance";
import { runOperationsAttentionReport } from "./families/operations-attention";
import { runPartnerPortfolioReport } from "./families/partner-portfolio";
import { runPartnerReviewEvidenceReport } from "./families/partner-review-evidence";
import { parseAppliedFilters } from "./filters";
import { requireReportsAccess, requireSourceFeatureAccess } from "./reports-gate";
import type { AppliedReportFilters, RawReportFilters, ReportId, ReportResult, ReportsServiceResult } from "./types";
import { isReportId, reportsInvalidInputResult, reportsNotFoundResult, reportsUnauthorizedResult } from "./types";

// Step 19A section 11: runReport -> actor-scoped canonical source services -> report-specific
// projector -> safe ReportResult. This is the ONE dispatch point every route calls through - never a
// route that talks to a family module directly, mirroring every other module's own "route resolves
// the actor and calls a service" discipline (see operations-static.test.ts's own guard for that
// shape).
type FamilyRunner = (actor: ActorContext, appliedFilters: AppliedReportFilters) => Promise<ReportsServiceResult<ReportResult>>;

const FAMILY_RUNNERS: Partial<Record<ReportId, FamilyRunner>> = {
  campaign_delivery: runCampaignDeliveryReport,
  campaign_performance: runCampaignPerformanceReport,
  channel_growth_freshness: runChannelGrowthFreshnessReport,
  partner_review_evidence: runPartnerReviewEvidenceReport,
  finance_status: runFinanceStatusReport,
  operations_attention: runOperationsAttentionReport,
  discovery_funnel: runDiscoveryFunnelReport,
  partner_portfolio: runPartnerPortfolioReport,
  administration_security: runAdministrationSecurityReport,
  monthly_partner_performance: runMonthlyPartnerPerformanceReport,
  campaign_event_performance: runCampaignEventPerformanceReport,
  cross_platform_partner_programme: runCrossPlatformPartnerProgrammeReport,
  long_period_partner_programme: runLongPeriodPartnerProgrammeReport,
};

export type RunReportOptions = { viewerSafe?: boolean };

// Section 17: families whose full result may carry Finance/Administration-sensitive detail are
// deliberately never runnable through the Viewer-safe path, regardless of what the acting role could
// otherwise reach through the full run path - a genuine, testable restriction (not merely a
// docstring) that keeps the Viewer boundary from becoming a generic authorization bypass.
const VIEWER_SAFE_BLOCKED_REPORT_IDS: ReadonlySet<ReportId> = new Set(["finance_status", "administration_security"]);

function toViewerSafeResult(result: ReportResult): ReportResult {
  // Strip internal fan-out/provenance detail (source function names, scanned counts) - the Viewer
  // boundary shows WHAT the report found, never how Reports composed it internally.
  return { ...result, provenance: [] };
}

export async function runReport(actor: ActorContext | null, rawReportId: unknown, rawFilters: RawReportFilters | undefined, options: RunReportOptions = {}): Promise<ReportsServiceResult<ReportResult>> {
  if (typeof rawReportId !== "string" || !isReportId(rawReportId)) return reportsNotFoundResult("Unknown report.");
  const reportId = rawReportId;
  const definition = getReportDefinition(reportId);

  const access = await requireReportsAccess(actor, options.viewerSafe ? undefined : "run_reports");
  if (!access.ok) return reportsUnauthorizedResult(access.reason);
  if (!actor) return reportsUnauthorizedResult("not_authenticated");

  if (options.viewerSafe && VIEWER_SAFE_BLOCKED_REPORT_IDS.has(reportId)) return reportsUnauthorizedResult("action_denied");

  const runner = FAMILY_RUNNERS[reportId];
  if (!runner) return reportsUnauthorizedResult("action_denied");

  const sourceAccess = await requireSourceFeatureAccess(actor, definition.requiredSourceFeatures);
  if (!sourceAccess.ok) return reportsUnauthorizedResult(sourceAccess.reason);

  const appliedFilters = parseAppliedFilters(rawFilters, definition);
  const result = await runner(actor, appliedFilters);
  if (!result.ok) return result;

  return { ok: true, data: options.viewerSafe ? toViewerSafeResult(result.data) : result.data };
}

export async function getReportDefinitionForActor(actor: ActorContext | null, rawReportId: unknown): Promise<ReportsServiceResult<ReturnType<typeof getReportDefinition>>> {
  if (typeof rawReportId !== "string" || !isReportId(rawReportId)) return reportsNotFoundResult("Unknown report.");
  const access = await requireReportsAccess(actor);
  if (!access.ok) return reportsUnauthorizedResult(access.reason);
  return { ok: true, data: getReportDefinition(rawReportId) };
}

export async function listReportCatalogForActor(actor: ActorContext | null): Promise<ReportsServiceResult<ReturnType<typeof getReportDefinition>[]>> {
  const access = await requireReportsAccess(actor);
  if (!access.ok) return reportsUnauthorizedResult(access.reason);
  return { ok: true, data: listReportDefinitions() };
}

export function assertReportIdOrInvalid(rawReportId: unknown): ReportsServiceResult<ReportId> {
  if (typeof rawReportId !== "string" || !isReportId(rawReportId)) return reportsInvalidInputResult("Unknown report id.");
  return { ok: true, data: rawReportId };
}
