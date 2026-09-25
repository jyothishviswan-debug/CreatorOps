import { listMyFinalizedSnapshots } from "@/server/reports";
import { resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// GET /api/reports/snapshots?limit=
// The acting user's own finalized report snapshot history, newest first - see firestore.ts's
// listReportSnapshotDocsByActor.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);
  const result = await listMyFinalizedSnapshots(actor, searchParams.get("limit") ?? undefined);
  return toReportsHttpResponse(result);
}
