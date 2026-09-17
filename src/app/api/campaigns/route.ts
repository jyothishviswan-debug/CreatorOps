import { NextResponse } from "next/server";

import { createCampaign, listCampaigns } from "@/server/campaigns/campaign-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";
import type { CampaignListCursor } from "@/server/campaigns/firestore";
import { compoundListCursorSchema } from "@/server/shared/scoped-list";

// GET /api/campaigns - scoped, bounded, cursor-paginated list.
// `cursor` is an opaque JSON-encoded compound cursor (one entry per
// active scope branch - see src/server/shared/scoped-list.ts); a
// malformed/tampered value is simply dropped (treated as "no cursor",
// same as an absent one), never trusted as-is.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const namePrefix = url.searchParams.get("namePrefix") ?? undefined;
  const region = url.searchParams.get("region") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const assignedToMe = url.searchParams.get("assignedToMe") === "true" ? true : undefined;

  let cursor: CampaignListCursor | undefined;
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw) {
    try {
      const parsed = compoundListCursorSchema.safeParse(JSON.parse(cursorRaw));
      if (parsed.success) cursor = parsed.data;
    } catch {
      // Malformed JSON - fall through with no cursor.
    }
  }

  const result = await listCampaigns(actor, { limit, cursor, status, namePrefix, region, platform, assignedToMe });
  return toCampaignsHttpResponse(result);
}

// POST /api/campaigns - direct Campaign creation (trusted server, action-gated).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createCampaign(actor, body, newRequestId());
  return toCampaignsHttpResponse(result, 201);
}
