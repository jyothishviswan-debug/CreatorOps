import { listContent } from "@/server/content/content-service";
import { resolveRequestActor, toContentHttpResponse } from "@/server/content/http";
import type { ContentListCursor } from "@/server/content/firestore";
import { compoundListCursorSchema } from "@/server/shared/scoped-list";

// GET /api/content - scoped, bounded, cursor-paginated list. `cursor` is
// an opaque JSON-encoded compound cursor (see
// src/server/shared/scoped-list.ts) - a malformed/tampered value is
// simply dropped (treated as "no cursor"), never trusted as-is.
//
// Step 11A.1: POST /api/content (generateContentFromAssignment, manual
// "Plan Content") is retired entirely - there is no manual Content-create
// operation anymore. A Content thread is created automatically, the
// first time a public submission session is created for an Assignment
// (see resolveOrCreateContentThread in
// @/server/content/content-service.ts, called from
// createExternalSubmissionSession).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const url = new URL(request.url);

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const assignmentRef = url.searchParams.get("assignmentRef") ?? undefined;
  const campaignRef = url.searchParams.get("campaignRef") ?? undefined;
  const partnerRef = url.searchParams.get("partnerRef") ?? undefined;
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

  const result = await listContent(actor, { limit, cursor, status, assignmentRef, campaignRef, partnerRef, assignedToMe });
  return toContentHttpResponse(result);
}
