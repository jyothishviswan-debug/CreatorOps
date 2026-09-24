import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { computeOperationsPermissions, getTask } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { TaskDetail } from "@/features/operations-tasks/detail/TaskDetail";

type RouteParams = { params: Promise<{ taskRef: string }> };

// Step 18B: /operations/tasks/[taskRef] - Task detail. A denied/not-found/out-of-scope task all
// render the same neutral state (loadAuthorizedTask's own "indistinguishable" discipline) - never a
// hint that a scoped-out task exists.
export default async function TaskDetailPage({ params }: RouteParams) {
  const { taskRef } = await params;
  const actor = await resolveRequestActor();
  const [permissions, result] = await Promise.all([computeOperationsPermissions(actor), getTask(actor, taskRef)]);

  if (!result.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">OPERATIONS / TASKS</div>
            <h1>Task not found</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Not found" description="This task does not exist, or you do not have access to it." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <TaskDetail initialTask={result.data} canCompleteTasks={permissions.canCompleteTasks} />
    </AppShell>
  );
}
