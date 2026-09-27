import { listReportRunVersionSummaries } from "@/server/reports";
import { resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// GET /api/reports/runs/[runRef]/versions - Version History (spec section 12's final workflow step).
export async function GET(_request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const result = await listReportRunVersionSummaries(actor, runRef);
  return toReportLifecycleHttpResponse(result);
}
