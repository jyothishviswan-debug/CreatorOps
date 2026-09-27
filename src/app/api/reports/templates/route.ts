import { NextResponse } from "next/server";

import { listReportTemplateDefinitions } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";
import { requireReportsAccess } from "@/server/reports/reports-gate";

// GET /api/reports/templates - the 7-template publication catalog (spec section 5). Gated on plain
// ordinary Reports view access (same as browsing the 13-report catalog) - choosing a template is not
// itself a mutating or sensitive action.
export async function GET() {
  const actor = await resolveRequestActor();
  const access = await requireReportsAccess(actor);
  if (!access.ok) return NextResponse.json({ error: "Forbidden." }, { status: actor ? 403 : 401 });
  return NextResponse.json(listReportTemplateDefinitions(), { status: 200 });
}
