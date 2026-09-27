import { NextResponse } from "next/server";

import { resumeAnalyticsImportBatch } from "@/server/analytics/import-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";
import { registerImportTargets } from "@/server/imports/register-targets";

registerImportTargets();

// POST /api/imports/resume
// { module: "analytics", batchRef, filename, mimeType, fileBase64, channelPlatform? }
// Import Center Completion (spec section 9): resumes a COMPLETED_WITH_ERRORS
// batch's quarantined rows only - never a new batch, never a duplicated
// row. The actor must re-upload the EXACT same source file (sourceHash
// checked server-side).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const { module: moduleKey, filename, mimeType, fileBase64, ...rest } = body as Record<string, unknown>;
  if (moduleKey !== "analytics") return NextResponse.json({ error: 'Unsupported import module for resume - only "analytics" supports resume today.' }, { status: 400 });
  if (typeof fileBase64 !== "string" || fileBase64.length === 0) return NextResponse.json({ error: "Missing file." }, { status: 400 });

  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(fileBase64, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid file encoding." }, { status: 400 });
  }

  const result = await resumeAnalyticsImportBatch(actor, { ...rest, fileBuffer, filename, mimeType } as never, newRequestId());
  return toAnalyticsHttpResponse(result);
}
