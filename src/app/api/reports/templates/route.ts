import { NextResponse } from "next/server";

import { getReportDefinition, listReportTemplateDefinitions } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";
import { requireReportsAccess } from "@/server/reports/reports-gate";

// GET /api/reports/templates - the 14-template publication catalog (spec sections 5/21). Gated on
// plain ordinary Reports view access (same as browsing the 13-report catalog) - choosing a template
// is not itself a mutating or sensitive action. Each entry also carries its underlying reportId's own
// `supportedFilters` (spec section 12's "Parameters" workflow step) - a template has no filters of
// its own; it always defers to the ReportDefinition it is backed by.
export async function GET() {
  const actor = await resolveRequestActor();
  const access = await requireReportsAccess(actor);
  if (!access.ok) return NextResponse.json({ error: "Forbidden." }, { status: actor ? 403 : 401 });
  const templates = listReportTemplateDefinitions().map((template) => ({ ...template, supportedFilters: getReportDefinition(template.reportId).supportedFilters }));
  return NextResponse.json(templates, { status: 200 });
}
