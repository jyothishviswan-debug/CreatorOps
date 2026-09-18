import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { AssignmentsWorkspace } from "@/features/assignments/AssignmentsWorkspace";
import { resolveRequestActor } from "@/server/assignments/http";
import { listAssignments } from "@/server/assignments/assignment-service";

export default async function AssignmentsPage() {
  const actor = await resolveRequestActor();
  // The service-layer gate fires before any Firestore read - a denied
  // actor (Viewer/Analyst) never causes an Assignment read to happen at
  // all, satisfying Step 10B section 3's "denied users must not fetch
  // Assignment data before denial" (the proxy-level Feature Access gate
  // in src/proxy.ts already redirects them to /access-denied before this
  // page component even renders, but this inline check stays as the
  // service-layer's own independent authority, same as Campaigns' page).
  const initial = await listAssignments(actor, { limit: 10 });

  if (!initial.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">PLAN &amp; DELIVER</div>
            <h1>Assignments</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Assignments data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PLAN &amp; DELIVER</div>
          <h1>Assignments</h1>
          <p>Partner-specific obligations across active campaigns.</p>
        </div>
      </div>

      <AssignmentsWorkspace initialAssignments={initial.data.assignments} initialNextCursor={initial.data.nextCursor} />
    </AppShell>
  );
}
