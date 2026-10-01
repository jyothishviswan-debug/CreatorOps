import { NextResponse } from "next/server";

import { generateAnalyticsImportTemplate } from "@/server/analytics/template-generator";
import { parseJsonBody, resolveRequestActor } from "@/server/analytics/http";

// POST /api/imports/analytics/template
// Finding #56: on-demand, no artifact-store/job involved (unlike Export Center/Report artifacts -
// see their own [ref]/artifact routes) - generated fresh from the request's own context every time.
// Re-authorizes here exactly like every other Import Center action (never a signed URL, never a
// client-trusted bypass); "selected"/"all" Partner resolution happens entirely server-side inside
// generateAnalyticsImportTemplate, so a forged/out-of-scope Partner ref can never widen what reaches
// the generated file.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await generateAnalyticsImportTemplate(actor, body);
  if (!result.ok) {
    if (result.code === "unauthorized") {
      const status = result.reason === "not_authenticated" ? 401 : 403;
      return NextResponse.json({ error: "Forbidden." }, { status });
    }
    const status = result.code === "invalid_input" ? 400 : 500;
    return NextResponse.json({ error: result.message }, { status });
  }

  const { bytes, filename } = result.data;
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
