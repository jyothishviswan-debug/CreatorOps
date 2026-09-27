import { NextResponse } from "next/server";

import { newRequestId, parseJsonBody, resolveRequestActor } from "@/server/analytics/http";
import { requireImportsModuleAccess } from "@/server/analytics/analytics-gate";
import { classifySystemError } from "@/server/imports/error-taxonomy";
import { previewImportFile } from "@/server/imports/preview";

// POST /api/imports/preview
// { filename, mimeType, fileBase64 }
// Import Center Completion (spec section 3): the generic, target-agnostic
// File/Sheet Preview step - runs BEFORE the actor even picks mapping
// options, gated only on generic Import Center module access (not on a
// specific target's own action permission, since no target has been
// engaged yet). Never mutates anything.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const gate = await requireImportsModuleAccess(actor);
  if (!gate.ok) {
    const status = gate.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: { category: "AUTHORIZATION", code: "ACTION_PERMISSION_DENIED", message: "You do not have permission to use the Import Center.", correctable: false } }, { status });
  }

  const body = await parseJsonBody(request);
  if (!body || typeof body !== "object") return NextResponse.json({ error: classifySystemError(newRequestId()) }, { status: 400 });

  const { filename, mimeType, fileBase64 } = body as Record<string, unknown>;
  if (typeof fileBase64 !== "string" || fileBase64.length === 0 || typeof filename !== "string" || typeof mimeType !== "string") {
    return NextResponse.json({ error: { category: "FILE", code: "MISSING_FILE", message: "Choose a file to preview.", correctable: true } }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(fileBase64, "base64");
  } catch {
    return NextResponse.json({ error: { category: "FILE", code: "INVALID_FILE_ENCODING", message: "The uploaded file could not be read.", correctable: true } }, { status: 400 });
  }

  const result = previewImportFile({ filename, mimeType, buffer });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
