import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { computeOperationsPermissions, getReminder } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { ReminderDetail } from "@/features/operations-reminders/detail/ReminderDetail";

type RouteParams = { params: Promise<{ reminderRef: string }> };

export default async function ReminderDetailPage({ params }: RouteParams) {
  const { reminderRef } = await params;
  const actor = await resolveRequestActor();
  const [permissions, result] = await Promise.all([computeOperationsPermissions(actor), getReminder(actor, reminderRef)]);

  if (!result.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">OPERATIONS / REMINDERS</div>
            <h1>Reminder not found</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Not found" description="This reminder does not exist, or you do not have access to it." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <ReminderDetail initialReminder={result.data} canManageReminders={permissions.canManageReminders} />
    </AppShell>
  );
}
