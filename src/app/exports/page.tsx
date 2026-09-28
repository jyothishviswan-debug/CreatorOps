import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { computeExportsPermissions, listExportTargetsForActor, listMyExportJobs } from "@/server/exports";
import { resolveRequestActor } from "@/server/exports/http";

import { ExportsWorkspace } from "@/features/exports/workspace/ExportsWorkspace";

// /exports IS the governed Export Center: a server component that resolves the actor, reads the real
// target catalog + the actor's own job history through the trusted service directly (mirrors
// src/app/reports/page.tsx's own shape), and renders one neutral denial state before any workspace
// content can flash. No fixture data anywhere in this route.
export default async function ExportsPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeExportsPermissions(actor);

  if (!permissions.canView) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">ACT & REPORT</div>
            <h1>Export Center</h1>
            <p>Governed export flow and export history.</p>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="You do not have access to Export Center" description="Ask an administrator for the exports feature grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const [targetsResult, jobsResult] = await Promise.all([listExportTargetsForActor(actor), listMyExportJobs(actor, undefined)]);

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">ACT & REPORT</div>
          <h1>Export Center</h1>
          <p>Governed export flow and export history.</p>
        </div>
      </div>

      {targetsResult.ok ? (
        <ExportsWorkspace targets={targetsResult.data} canCreateExports={permissions.canCreateExports} initialJobs={jobsResult.ok ? jobsResult.data : []} serverNowIso={new Date().toISOString()} />
      ) : (
        <section className="panel">
          <EmptyState title="Could not load the export catalog" description={targetsResult.message} icon="alert" />
        </section>
      )}
    </AppShell>
  );
}
