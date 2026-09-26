import { getExportJobForActor } from "@/server/exports";
import { resolveRequestActor, toExportsHttpResponse } from "@/server/exports/http";

// GET /api/exports/jobs/[jobRef]
// One export job, scoped to the acting user's own createdByUserRef - a guessed/foreign jobRef gets
// the same neutral 404 a genuinely-missing one would (see export-service.ts's getExportJobForActor).
export async function GET(_request: Request, { params }: { params: Promise<{ jobRef: string }> }) {
  const actor = await resolveRequestActor();
  const { jobRef } = await params;
  const result = await getExportJobForActor(actor, jobRef);
  return toExportsHttpResponse(result);
}
