import { listArtifactsForVersion } from "@/server/reports";
import { resolveRequestActor, toReportLifecycleHttpResponse } from "@/server/reports/http";

// GET /api/reports/runs/[runRef]/artifacts?version=N
export async function GET(request: Request, { params }: { params: Promise<{ runRef: string }> }) {
  const actor = await resolveRequestActor();
  const { runRef } = await params;
  const url = new URL(request.url);
  const versionRaw = url.searchParams.get("version");
  const version = versionRaw !== null && /^\d+$/.test(versionRaw) ? Number(versionRaw) : NaN;
  const result = await listArtifactsForVersion(actor, runRef, version);
  return toReportLifecycleHttpResponse(result);
}
