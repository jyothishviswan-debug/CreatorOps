import { NextResponse } from "next/server";

import { getAnalyticsImportBatchDetail } from "@/server/analytics/import-history-service";
import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";
import { getContentLinkImportBatchDetail } from "@/server/imports/content-link-import";
import { getContractBundleImportBatchDetail } from "@/server/imports/contract-bundle-import";

type RouteParams = { params: Promise<{ batchRef: string }> };

// GET /api/imports/batches/[batchRef]?module=analytics|contract_bundle|content_links
export async function GET(request: Request, { params }: RouteParams) {
  const { batchRef } = await params;
  const actor = await resolveRequestActor();
  const moduleKey = new URL(request.url).searchParams.get("module") ?? "analytics";

  if (moduleKey === "contract_bundle") {
    const result = await getContractBundleImportBatchDetail(actor, batchRef);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 404 });
    return NextResponse.json(result.data);
  }

  // Finding #44 (user-decided): a separate, semantically correct target kind - never folded into
  // AnalyticsTargetKind.
  if (moduleKey === "content_links") {
    const result = await getContentLinkImportBatchDetail(actor, batchRef);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 404 });
    return NextResponse.json(result.data);
  }

  const result = await getAnalyticsImportBatchDetail(actor, batchRef);
  return toAnalyticsHttpResponse(result);
}
