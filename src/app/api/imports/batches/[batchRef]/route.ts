import { getAnalyticsImportBatchDetail } from "@/server/analytics/import-history-service";
import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";

type RouteParams = { params: Promise<{ batchRef: string }> };

// GET /api/imports/batches/[batchRef] - Import History detail (Section 16).
export async function GET(_request: Request, { params }: RouteParams) {
  const { batchRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getAnalyticsImportBatchDetail(actor, batchRef);
  return toAnalyticsHttpResponse(result);
}
