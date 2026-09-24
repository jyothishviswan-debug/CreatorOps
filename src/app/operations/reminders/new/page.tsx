import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { computeOperationsPermissions } from "@/server/operations";
import { resolveRequestActor } from "@/server/operations/http";

import { CreateReminderForm } from "@/features/operations-reminders/create/CreateReminderForm";

export default async function CreateReminderPage() {
  const actor = await resolveRequestActor();
  const permissions = await computeOperationsPermissions(actor);

  if (!permissions.canManageReminders) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">OPERATIONS / REMINDERS</div>
            <h1>Create Reminder</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="You do not have access to create Reminders" description="Ask an administrator for the manage_reminders grant if you believe this is wrong." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / REMINDERS</div>
          <h1>Create Reminder</h1>
          <p>Track scheduled operational follow-up.</p>
        </div>
        <div className="actions">
          <Link className="btn" href="/operations/reminders">
            Back to Reminders
          </Link>
        </div>
      </div>
      <CreateReminderForm />
    </AppShell>
  );
}
