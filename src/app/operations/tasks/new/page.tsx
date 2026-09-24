import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { computeOperationsPermissions } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { CreateTaskForm } from "@/features/operations-tasks/create/CreateTaskForm";

// Step 18B: /operations/tasks/new - Create Task. No ModuleTabs (detail/create pages never show the
// sibling workspace tab row, same convention as every other module's own New page).
export default async function CreateTaskPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeOperationsPermissions(actor);

  if (!permissions.canManageTasks) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">OPERATIONS / TASKS</div>
            <h1>Create Task</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="You do not have access to create Tasks" description="Ask an administrator for the manage_tasks grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / TASKS</div>
          <h1>Create Task</h1>
          <p>Track operational work across CreatorOps.</p>
        </div>
        <div className="actions">
          <Link className="btn" href="/operations">
            Back to Tasks
          </Link>
        </div>
      </div>
      <CreateTaskForm />
    </AppShell>
  );
}
