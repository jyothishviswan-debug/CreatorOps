import { listExportTargetsForActor } from "@/server/exports";
import { resolveRequestActor, toExportsHttpResponse } from "@/server/exports/http";

// GET /api/exports
// The governed export-target catalog: every ExportTargetDefinition the acting user's own "exports"
// FeatureAccess grant permits seeing. Catalog visibility is broad (view-only) - actually creating a
// job additionally requires create_exports and the target's own required source FeatureAccess (see
// jobs/route.ts).
export async function GET() {
  const actor = await resolveRequestActor();
  const result = await listExportTargetsForActor(actor);
  return toExportsHttpResponse(result);
}
