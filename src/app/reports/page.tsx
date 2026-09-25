import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { computeReportsPermissions, listReportCatalogForActor } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";

import { REPORTS_TABS } from "@/features/reports/reports-tabs";
import { ReportsCatalog } from "@/features/reports/workspace/ReportsCatalog";

// Step 19B: /reports IS the governed report catalog - a server component that resolves the actor,
// reads the real 13-entry catalog through the trusted service directly (mirrors
// src/app/operations/page.tsx's own shape), and renders one neutral denial state before any
// workspace content can flash. No fixture data anywhere in this route.
export default async function ReportsPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeReportsPermissions(actor);

  if (!permissions.canView) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">REPORTS</div>
            <h1>Reports</h1>
            <p>Turn verified programme evidence into governed, reviewable outputs.</p>
          </div>
        </div>
        <ModuleTabs tabs={REPORTS_TABS} />
        <section className="panel">
          <EmptyState title="You do not have access to Reports" description="Ask an administrator for the reports feature grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const result = await listReportCatalogForActor(actor);

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">REPORTS</div>
          <h1>Reports</h1>
          <p>Turn verified programme evidence into governed, reviewable outputs.</p>
        </div>
      </div>

      <ModuleTabs tabs={REPORTS_TABS} />

      {result.ok ? (
        <ReportsCatalog definitions={result.data} canRunReports={permissions.canRunReports} />
      ) : (
        <section className="panel">
          <EmptyState title="Could not load the report catalog" description={result.message} icon="alert" />
        </section>
      )}
    </AppShell>
  );
}
