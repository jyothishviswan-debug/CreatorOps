import { NextResponse } from "next/server";

import { executeAnalyticsImport } from "@/server/analytics/import-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toAnalyticsHttpResponse } from "@/server/analytics/http";
import { classifySystemError } from "@/server/imports/error-taxonomy";
import { registerImportTargets } from "@/server/imports/register-targets";
import { getImportTarget, ImportAdapterError } from "@/server/imports/target-registry";

registerImportTargets();

// POST /api/imports/execute
// { module: "analytics" | "contract_bundle", targetKind?, filename, mimeType, fileBase64, ...adapter-specific options }
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const { module: moduleKey, filename, mimeType, fileBase64, ...rest } = body as Record<string, unknown>;
  if (typeof fileBase64 !== "string" || fileBase64.length === 0) return NextResponse.json({ error: "Missing file." }, { status: 400 });

  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(fileBase64, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid file encoding." }, { status: 400 });
  }

  if (moduleKey === "analytics") {
    const result = await executeAnalyticsImport(actor, { ...rest, fileBuffer, filename, mimeType } as never, newRequestId());
    return toAnalyticsHttpResponse(result);
  }

  const target = typeof moduleKey === "string" ? getImportTarget(moduleKey) : null;
  if (!target) return NextResponse.json({ error: `Unsupported import module "${String(moduleKey)}".` }, { status: 400 });

  try {
    const result = await target.execute(actor, { buffer: fileBuffer, filename: filename as string, mimeType: mimeType as string }, rest, newRequestId());
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ImportAdapterError) {
      const status = error.classified.category === "AUTHORIZATION" ? 403 : 400;
      return NextResponse.json({ error: error.classified }, { status });
    }
    return NextResponse.json({ error: classifySystemError() }, { status: 500 });
  }
}
