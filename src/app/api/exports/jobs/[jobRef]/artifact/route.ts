import { NextResponse } from "next/server";

import { getExportArtifactForActor } from "@/server/exports";
import { resolveRequestActor } from "@/server/exports/http";

// GET /api/exports/jobs/[jobRef]/artifact
// Private artifact delivery. Re-authorizes at delivery time (actor must hold exports access AND own
// the job AND the job must be COMPLETED) - never a signed URL, never a raw provider locator, and a
// guessed/foreign/incomplete jobRef gets the same neutral 404 a genuinely-missing one would.
export async function GET(_request: Request, { params }: { params: Promise<{ jobRef: string }> }) {
  const actor = await resolveRequestActor();
  const { jobRef } = await params;
  const result = await getExportArtifactForActor(actor, jobRef);

  if (!result.ok) {
    if (result.code === "unauthorized") {
      const status = result.reason === "not_authenticated" ? 401 : 403;
      return NextResponse.json({ error: "Forbidden." }, { status });
    }
    const status = result.code === "not_found" ? 404 : 500;
    return NextResponse.json({ error: result.message }, { status });
  }

  const { bytes, mimeType, fileName } = result.data;
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9_.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
