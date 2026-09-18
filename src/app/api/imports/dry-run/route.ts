import { NextResponse } from "next/server";

import { dryRunAnalyticsImport } from "@/server/analytics/import-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";
import { registerImportTargets } from "@/server/imports/register-targets";

registerImportTargets();

// POST /api/imports/dry-run
// { module: "analytics", targetKind, filename, mimeType, fileBase64, reportingPeriod?, channelPlatform? }
// Minimal, real Import Center wiring for /imports?module=analytics -
// Analytics is (for now) the only registered target (see
// @/server/imports/target-registry.ts), so `module` is validated but not
// yet dispatched through the generic registry lookup for THIS route
// (the analytics service is called directly for precise error-code
// mapping via toAnalyticsHttpResponse) - the registry itself is still a
// real, populated mechanism (see registerImportTargets/getImportTarget),
// ready for a second target to plug into later.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const { module: moduleKey, filename, mimeType, fileBase64, ...rest } = body as Record<string, unknown>;
  if (moduleKey !== "analytics") return NextResponse.json({ error: 'Unsupported import module - only "analytics" is registered.' }, { status: 400 });
  if (typeof fileBase64 !== "string" || fileBase64.length === 0) return NextResponse.json({ error: "Missing file." }, { status: 400 });

  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(fileBase64, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid file encoding." }, { status: 400 });
  }

  const result = await dryRunAnalyticsImport(actor, { ...rest, fileBuffer, filename, mimeType } as never, newRequestId());
  return toAnalyticsHttpResponse(result);
}
