import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { computeReportsPermissions, listMyFinalizedSnapshots, listReportDefinitions } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";

import { REPORTS_TABS } from "@/features/reports/reports-tabs";
import { SnapshotsList } from "@/features/reports/snapshots/SnapshotsList";

// Step 19B section 15: the acting user's OWN finalized report snapshots, newest first. The
// underlying service (listMyFinalizedSnapshots) scopes strictly by actor.userRef regardless of the
// "reports" feature grant (a finalized snapshot the actor already created remains theirs to re-open
// even if that grant is later revoked) - this page still sits behind the same canView gate as every
// other Reports screen for UI consistency, matching the discipline every other real module page uses.
export default async function ReportSnapshotsPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeReportsPermissions(actor);

  if (!permissions.canView) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">REPORTS</div>
            <h1>Your finalized reports</h1>
          </div>
        </div>
        <ModuleTabs tabs={REPORTS_TABS} />
        <section className="panel">
          <EmptyState title="You do not have access to Reports" description="Ask an administrator for the reports feature grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const result = await listMyFinalizedSnapshots(actor, undefined);

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">REPORTS</div>
          <h1>Your finalized reports</h1>
          <p>Immutable snapshots you finalized - visible only to you, never a shared organization-wide list.</p>
        </div>
      </div>

      <ModuleTabs tabs={REPORTS_TABS} />

      {result.ok ? (
        <SnapshotsList snapshots={result.data} definitions={listReportDefinitions()} />
      ) : (
        <section className="panel">
          <EmptyState title="Could not load your finalized reports" description={result.message} icon="alert" />
        </section>
      )}
    </AppShell>
  );
}
