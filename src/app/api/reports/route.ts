import { listReportCatalogForActor } from "@/server/reports";
import { resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// GET /api/reports
// The governed report catalog: every ReportDefinition the acting user's own "reports" FeatureAccess
// grant permits seeing (section 4). Catalog visibility is broad (view-only) - individual reports may
// be stricter to actually RUN (see [reportId]/run, [reportId]/viewer-run).
export async function GET() {
  const actor = await resolveRequestActor();
  const result = await listReportCatalogForActor(actor);
  return toReportsHttpResponse(result);
}
