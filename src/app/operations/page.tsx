import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { computeOperationsPermissions, listTasks } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { OPERATIONS_TABS } from "@/features/operations/operations-tabs";
import { TasksWorkspace } from "@/features/operations-tasks/workspace/TasksWorkspace";

// Step 18B: /operations IS the Tasks workspace (spec's canonical route list - no separate
// /operations/overview). A server component: resolves the actor, reads the first bounded page
// through the trusted service directly (mirrors src/app/finance/payments/page.tsx's own shape), and
// renders one neutral state on denial - never a flash of the workspace before an authorization
// check lands.
export default async function OperationsPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeOperationsPermissions(actor);

  if (!permissions.canView) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">OPERATIONS / TASKS</div>
            <h1>Tasks</h1>
            <p>Track operational work across CreatorOps.</p>
          </div>
        </div>
        <ModuleTabs tabs={OPERATIONS_TABS} />
        <section className="panel">
          <EmptyState title="You do not have access to Operations" description="Ask an administrator for the operations feature grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const result = await listTasks(actor, { limit: 100 });

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / TASKS</div>
          <h1>Tasks</h1>
          <p>Track operational work across CreatorOps.</p>
        </div>
        {permissions.canManageTasks && (
          <div className="actions">
            <Link className="btn primary" href="/operations/tasks/new">
              Create Task
            </Link>
          </div>
        )}
      </div>

      <ModuleTabs tabs={OPERATIONS_TABS} />

      {result.ok ? (
        <TasksWorkspace initialTasks={result.data.tasks} canManageTasks={permissions.canManageTasks} serverNowIso={new Date().toISOString()} />
      ) : (
        <section className="panel">
          <EmptyState title="Could not load Tasks" description={result.message} icon="alert" />
        </section>
      )}
    </AppShell>
  );
}
