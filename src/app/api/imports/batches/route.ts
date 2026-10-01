import { NextResponse } from "next/server";

import { listAnalyticsImportBatches } from "@/server/analytics/import-history-service";
import { resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";
import { listContentLinkImportBatches } from "@/server/imports/content-link-import";
import { listContractBundleImportBatches } from "@/server/imports/contract-bundle-import";

// GET /api/imports/batches?module=analytics|contract_bundle|content_links - Import
// History list (Section 16 / Import Center Completion section 11).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);
  const moduleKey = url.searchParams.get("module") ?? "analytics";

  if (moduleKey === "contract_bundle") {
    const limitParam = url.searchParams.get("limit");
    const result = await listContractBundleImportBatches(actor, limitParam ? Number(limitParam) : undefined);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 403 });
    return NextResponse.json({ batches: result.data });
  }

  // Finding #44 (user-decided): a separate, semantically correct target kind - never folded into
  // AnalyticsTargetKind.
  if (moduleKey === "content_links") {
    const limitParam = url.searchParams.get("limit");
    const result = await listContentLinkImportBatches(actor, limitParam ? Number(limitParam) : undefined);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 403 });
    return NextResponse.json({ batches: result.data });
  }

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
