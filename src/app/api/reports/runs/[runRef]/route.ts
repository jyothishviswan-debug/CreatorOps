import { getReportRunDetail } from "@/server/reports";
import { resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// GET /api/reports/runs/[runRef]?version=N
// Reports Final-Master: read a run's detail (defaults to its current finalized version, else its
// open version, else its latest) - visibility is enforced inside the service (DRAFT/IN_REVIEW is
// private to its own drafter; FINALIZED/SUPERSEDED is visible to any actor with ordinary current
// Reports + source-feature access - see report-lifecycle-service.ts's own canViewReportVersion).
export async function GET(request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const url = new URL(request.url);
  const versionRaw = url.searchParams.get("version");
  const version = versionRaw !== null && /^\d+$/.test(versionRaw) ? Number(versionRaw) : undefined;
  const result = await getReportRunDetail(actor, runRef, version);
  return toReportLifecycleHttpResponse(result);
}
