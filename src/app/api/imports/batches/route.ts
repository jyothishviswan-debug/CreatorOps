import { listAnalyticsImportBatches } from "@/server/analytics/import-history-service";
import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";

// GET /api/imports/batches - Import History list (Section 16).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const targetKind = url.searchParams.get("targetKind") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const cursorRaw = url.searchParams.get("cursor");

  let cursor: { createdAt: string; uid: string } | undefined;
  if (cursorRaw) {
    try {
      const parsed = JSON.parse(cursorRaw);
      if (parsed && typeof parsed.createdAt === "string" && typeof parsed.uid === "string") cursor = parsed;
    } catch {
      // Malformed cursor - fall through with no cursor.
    }
  }

  const result = await listAnalyticsImportBatches(actor, { limit: limitParam ? Number(limitParam) : undefined, cursor, targetKind, status });
  return toAnalyticsHttpResponse(result);
}
