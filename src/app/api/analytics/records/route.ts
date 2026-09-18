import { listAnalyticsSourceRecords } from "@/server/analytics/explorer-service";
import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";

// GET /api/analytics/records - Data Explorer (Section 15). Scoped,
// bounded, cursor-paginated raw source-record listing (never a read-model
// aggregate).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const recordKind = url.searchParams.get("recordKind") ?? "content";
  const limitParam = url.searchParams.get("limit");
  const matchState = url.searchParams.get("matchState") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const batchRef = url.searchParams.get("batchRef") ?? undefined;
  const matchedCampaignRef = url.searchParams.get("matchedCampaignRef") ?? undefined;
  const matchedPartnerRef = url.searchParams.get("matchedPartnerRef") ?? undefined;
  const matchedPartnerAccountRef = url.searchParams.get("matchedPartnerAccountRef") ?? undefined;
  const matchedContentRef = url.searchParams.get("matchedContentRef") ?? undefined;

  let cursor: Record<string, unknown> | undefined;
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw) {
    try {
      cursor = JSON.parse(cursorRaw);
    } catch {
      // Malformed cursor - fall through with no cursor.
    }
  }

  const result = await listAnalyticsSourceRecords(actor, {
    recordKind,
    limit: limitParam ? Number(limitParam) : undefined,
    cursor,
    matchState,
    platform,
    batchRef,
    matchedCampaignRef,
    matchedPartnerRef,
    matchedPartnerAccountRef,
    matchedContentRef,
  });
  return toAnalyticsHttpResponse(result);
}
