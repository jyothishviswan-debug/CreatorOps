import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { computeReportsPermissions, getReportDefinition, listReportTemplateDefinitions } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";

import { REPORTS_TABS } from "@/features/reports/reports-tabs";
import { PublishWorkspace } from "@/features/reports/publish/PublishWorkspace";

// Reports Final-Master (spec section 12): the publication workflow - Choose Report -> Parameters ->
// Run -> Evidence Preview -> Narrative -> Review -> Finalize -> Artifacts -> Version History. Reuses
// the existing Reports AppShell/ModuleTabs/permission-gate shape exactly (mirrors src/app/reports/
// page.tsx's own server-component pattern) - a new sibling tab, not a parallel Reports surface.
export default async function ReportsPublishPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeReportsPermissions(actor);

  if (!permissions.canView || !permissions.canRunReports) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">REPORTS</div>
            <h1>Publish</h1>
            <p>Turn verified programme evidence into a formal, versioned management report.</p>
          </div>
        </div>
        <ModuleTabs tabs={REPORTS_TABS} />
        <section className="panel">
          <EmptyState title="You do not have access to publish reports" description="Ask an administrator for the reports run_reports grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const templates = listReportTemplateDefinitions().map((template) => ({ ...template, supportedFilters: getReportDefinition(template.reportId).supportedFilters }));

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">REPORTS</div>
          <h1>Publish</h1>
          <p>Choose a template, run evidence, write the narrative, review, and finalize a formal management report.</p>
        </div>
      </div>
      <ModuleTabs tabs={REPORTS_TABS} />
      <PublishWorkspace templates={templates} />
    </AppShell>
  );
}
