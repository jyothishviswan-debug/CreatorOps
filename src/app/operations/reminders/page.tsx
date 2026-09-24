import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { computeOperationsPermissions, listReminders } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { OPERATIONS_TABS } from "@/features/operations/operations-tabs";
import { RemindersWorkspace } from "@/features/operations-reminders/workspace/RemindersWorkspace";

export default async function OperationsRemindersPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeOperationsPermissions(actor);

  if (!permissions.canView) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">OPERATIONS / REMINDERS</div>
            <h1>Reminders</h1>
            <p>Track scheduled operational follow-up.</p>
          </div>
        </div>
        <ModuleTabs tabs={OPERATIONS_TABS} />
        <section className="panel">
          <EmptyState title="You do not have access to Operations" icon="lock" />
        </section>
      </AppShell>
    );
  }

  const result = await listReminders(actor, { limit: 100 });

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / REMINDERS</div>
          <h1>Reminders</h1>
          <p>Track scheduled operational follow-up.</p>
        </div>
        {permissions.canManageReminders && (
          <div className="actions">
            <Link className="btn primary" href="/operations/reminders/new">
              Create Reminder
            </Link>
          </div>
        )}
      </div>

      <ModuleTabs tabs={OPERATIONS_TABS} />

      {result.ok ? (
        <RemindersWorkspace initialReminders={result.data.reminders} canManageReminders={permissions.canManageReminders} />
      ) : (
        <section className="panel">
          <EmptyState title="Could not load Reminders" description={result.message} icon="alert" />
        </section>
      )}
    </AppShell>
  );
}
