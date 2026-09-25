import { getFinalizedSnapshot } from "@/server/reports";
import { resolveRequestActor, toReportsHttpResponse } from "@/server/reports/http";

// GET /api/reports/snapshots/[snapshotRef]
// Reads back one immutable finalized snapshot - only ever visible to the actor who finalized it (see
// snapshot-service.ts's getFinalizedSnapshot).
export async function GET(_request: Request, { params }: { params: Promise<{ snapshotRef: string }> }) {
  const actor = await resolveRequestActor();
  const { snapshotRef } = await params;
  const result = await getFinalizedSnapshot(actor, snapshotRef);
  return toReportsHttpResponse(result);
}
