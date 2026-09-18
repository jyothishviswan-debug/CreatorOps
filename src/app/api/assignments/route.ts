import { NextResponse } from "next/server";

import { createAssignment, listAssignments } from "@/server/assignments/assignment-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";
import type { AssignmentListCursor } from "@/server/assignments/firestore";
import { compoundListCursorSchema } from "@/server/shared/scoped-list";

// GET /api/assignments - scoped, bounded, cursor-paginated list.
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
  const campaignRef = url.searchParams.get("campaignRef") ?? undefined;
  const partnerRef = url.searchParams.get("partnerRef") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const assignedToMe = url.searchParams.get("assignedToMe") === "true" ? true : undefined;

  let cursor: AssignmentListCursor | undefined;
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw) {
    try {
      const parsed = compoundListCursorSchema.safeParse(JSON.parse(cursorRaw));
      if (parsed.success) cursor = parsed.data;
    } catch {
      // Malformed JSON - fall through with no cursor.
    }
  }

  const result = await listAssignments(actor, { limit, cursor, status, campaignRef, partnerRef, platform, assignedToMe });
  return toAssignmentsHttpResponse(result);
}

// POST /api/assignments - direct Assignment creation (trusted server,
// action-gated, cross-record-validated against the owning Campaign and
// Partner).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createAssignment(actor, body, newRequestId());
  return toAssignmentsHttpResponse(result, 201);
}
