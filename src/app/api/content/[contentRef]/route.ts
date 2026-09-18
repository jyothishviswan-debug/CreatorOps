import { getContent } from "@/server/content/content-service";
import { resolveRequestActor, toContentHttpResponse } from "@/server/content/http";

type RouteParams = { params: Promise<{ contentRef: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { contentRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getContent(actor, contentRef);
  return toContentHttpResponse(result);
}
