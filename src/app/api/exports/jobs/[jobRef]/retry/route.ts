import { retryExportJob } from "@/server/exports";
import { resolveRequestActor, toExportsHttpResponse } from "@/server/exports/http";

// POST /api/exports/jobs/[jobRef]/retry
// Section 14: retry/regenerate. Reauthorizes and reruns the source query against CURRENT data - never
// reuses the original job's own authorization decision (see export-service.ts's retryExportJob). A
// guessed/foreign jobRef gets the same neutral 404 a genuinely-missing one would.
export async function POST(_request: Request, { params }: { params: Promise<{ jobRef: string }> }) {
  const actor = await resolveRequestActor();
  const { jobRef } = await params;
  const result = await retryExportJob(actor, jobRef);
  return toExportsHttpResponse(result, 201);
}
