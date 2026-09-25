import { getReportDefinitionForActor } from "@/server/reports";
import { resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// GET /api/reports/[reportId]
// One report's own governed definition (filters/metrics/sections/limitations/artifact metadata).
export async function GET(_request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const actor = await resolveRequestActor();
  const { reportId } = await params;
  const result = await getReportDefinitionForActor(actor, reportId);
  return toReportsHttpResponse(result);
}
