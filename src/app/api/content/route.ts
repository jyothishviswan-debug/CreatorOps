import { NextResponse } from "next/server";

import { generateContentFromAssignment, listContent } from "@/server/content/content-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toContentHttpResponse } from "@/server/content/http";
import type { ContentListCursor } from "@/server/content/firestore";
import { compoundListCursorSchema } from "@/server/shared/scoped-list";

// GET /api/content - scoped, bounded, cursor-paginated list. `cursor` is
// an opaque JSON-encoded compound cursor (see
// src/server/shared/scoped-list.ts) - a malformed/tampered value is
// simply dropped (treated as "no cursor"), never trusted as-is.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const assignmentRef = url.searchParams.get("assignmentRef") ?? undefined;
  const campaignRef = url.searchParams.get("campaignRef") ?? undefined;
  const partnerRef = url.searchParams.get("partnerRef") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const reviewPolicy = url.searchParams.get("reviewPolicy") ?? undefined;
  const assignedToMe = url.searchParams.get("assignedToMe") === "true" ? true : undefined;

  let cursor: ContentListCursor | undefined;
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw) {
    try {
      const parsed = compoundListCursorSchema.safeParse(JSON.parse(cursorRaw));
      if (parsed.success) cursor = parsed.data;
    } catch {
      // Malformed JSON - fall through with no cursor.
    }
  }

  const result = await listContent(actor, { limit, cursor, status, assignmentRef, campaignRef, partnerRef, platform, reviewPolicy, assignedToMe });
  return toContentHttpResponse(result);
}

// POST /api/content - generate a new Content record from an Assignment
// (trusted server, action-gated, race-safe required-slot claiming).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await generateContentFromAssignment(actor, body, newRequestId());
  return toContentHttpResponse(result, 201);
}
