import { NextResponse } from "next/server";

import { downloadReportArtifact } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";

// GET /api/reports/artifacts/[artifactRef]/download
// Reports Final-Master (spec section 23): the ONE download path - re-authorizes on every call (see
// download-service.ts's own disclosed "current access, not publication-time snapshot" policy). Never
// returns a signed URL or a raw Storage locator; the browser gets bytes with a safe, server-generated
// filename, once it has passed authorization.
export async function GET(_request: Request, { params }: { params: Promise<{ artifactRef: string }> }) {
  const actor = await resolveRequestActor();
  const { artifactRef } = await params;
  const result = await downloadReportArtifact(actor, artifactRef);
  if (!result.ok) {
    if (result.code === "unauthorized") return NextResponse.json({ error: "Forbidden." }, { status: result.reason === "not_authenticated" ? 401 : 403 });
    if (result.code === "not_found") return NextResponse.json({ error: result.message }, { status: 404 });
    return NextResponse.json({ error: result.message }, { status: 500 });
  }
  const { bytes, contentType, safeFilename } = result.data;
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
