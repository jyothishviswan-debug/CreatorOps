import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { computeReportsPermissions, getReportDefinitionForActor } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";

import { ReportRunner } from "@/features/reports/detail/ReportRunner";
import { REPORTS_TABS } from "@/features/reports/reports-tabs";

type RouteParams = { params: Promise<{ reportId: string }> };

// Step 19B: /reports/[reportId] - select one governed report definition, configure its OWN
// server-declared supportedFilters, run it (full or viewer-safe, per the actor's real permissions),
// and view the result. A denied/unknown reportId renders the same neutral "not found" state (never a
// hint that a report id exists but is out of the actor's scope), same discipline as
// src/app/operations/tasks/[taskRef]/page.tsx.
export default async function ReportDetailPage({ params }: RouteParams) {
  const { reportId } = await params;
  const actor = await resolveRequestActor();
  const permissions = await computeReportsPermissions(actor);

  if (!permissions.canView) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">REPORTS</div>
            <h1>Reports</h1>
          </div>
        </div>
        <ModuleTabs tabs={REPORTS_TABS} />
        <section className="panel">
          <EmptyState title="You do not have access to Reports" description="Ask an administrator for the reports feature grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const result = await getReportDefinitionForActor(actor, reportId);
  if (!result.ok) notFound();
  const definition = result.data;

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">REPORTS / {definition.reportId.toUpperCase()}</div>
          <h1>{definition.title}</h1>
          <p>{definition.purpose}</p>
        </div>
      </div>

      <ModuleTabs tabs={REPORTS_TABS} />

      <ReportRunner definition={definition} permissions={permissions} />
    </AppShell>
  );
}
