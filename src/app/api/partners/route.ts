import { NextResponse } from "next/server";

import { createPartner, listPartners } from "@/server/partners/partner-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toPartnersHttpResponse } from "@/server/partners/http";
import type { PartnerListCursor } from "@/server/partners/firestore";
import { compoundListCursorSchema } from "@/server/shared/scoped-list";

// GET /api/partners - scoped, bounded, cursor-paginated list.
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
  const displayNamePrefix = url.searchParams.get("displayNamePrefix") ?? undefined;
  const regionValues = url.searchParams.getAll("region");
  const region = regionValues.length > 0 ? regionValues : undefined;
  const tier = url.searchParams.get("tier") ?? undefined;
  const targetAudience = url.searchParams.get("targetAudience") ?? undefined;
  const assignedToMe = url.searchParams.get("assignedToMe") === "true" ? true : undefined;
  const pendingPartnerAccountSetup = url.searchParams.get("pendingPartnerAccountSetup") === "true" ? true : undefined;

  let cursor: PartnerListCursor | undefined;
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw) {
    try {
      const parsed = compoundListCursorSchema.safeParse(JSON.parse(cursorRaw));
      if (parsed.success) cursor = parsed.data;
    } catch {
      // Malformed JSON - fall through with no cursor.
    }
  }

  const result = await listPartners(actor, { limit, cursor, status, displayNamePrefix, region, tier, targetAudience, assignedToMe, pendingPartnerAccountSetup });
  return toPartnersHttpResponse(result);
}

// POST /api/partners - direct Partner creation (trusted server, action-gated).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPartner(actor, body, newRequestId());
  return toPartnersHttpResponse(result, 201);
}
