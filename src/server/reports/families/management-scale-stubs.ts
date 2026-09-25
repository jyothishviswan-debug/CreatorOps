import type { ReportId, ReportsServiceResult } from "../types";
import { reportsUnsupportedResult } from "../types";
import type { ReportResult } from "../types";

// Section 13: the four "management-scale" families have no real backend today - only illustrative
// UI-placeholder fixture names (src/features/reports/fixtures/index.ts). Their catalog entries are
// real and stable (see catalog.ts), but executing them here would mean fabricating a cross-module
// combination formula/definition that does not exist anywhere in the accepted product model yet -
// exactly what section 13 forbids ("do not fabricate narrative topics, classifications, leaderboards
// or combined metrics unless explicit source fields/definitions support them"). So every one of these
// returns the SAME explicit, typed "unsupported" result - never a fake ReportResult, never partial
// fabricated data pretending to be complete.
const MANAGEMENT_SCALE_REPORT_IDS: ReportId[] = ["monthly_partner_performance", "campaign_event_performance", "cross_platform_partner_programme", "long_period_partner_programme"];

export function isManagementScaleStub(reportId: ReportId): boolean {
  return MANAGEMENT_SCALE_REPORT_IDS.includes(reportId);
}

export async function runManagementScaleStub(reportId: ReportId): Promise<ReportsServiceResult<ReportResult>> {
  return reportsUnsupportedResult(`"${reportId}" is registered in the Reports catalog but has no execution in Step 19A - see its definition's own limitations for why.`);
}
