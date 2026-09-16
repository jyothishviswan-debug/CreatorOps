import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { AdministrationUsersWorkspace } from "@/features/administration/AdministrationUsersWorkspace";
import { resolveRequestActor } from "@/server/administration/http";
import { listUsers } from "@/server/administration/users-service";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

const INITIAL_LIMIT = 10;

export default async function AdministrationUsersPage() {
  const actor = await resolveRequestActor();
  const result = await listUsers(actor, { limit: INITIAL_LIMIT });

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">SYSTEM GOVERNANCE</div>
          <h1>Users</h1>
          <p>Registered accounts and their assigned roles.</p>
        </div>
        <div className="actions">
          <Link href="/administration/users/new" className="btn primary">
            + New user
          </Link>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      {result.ok ? (
        <AdministrationUsersWorkspace initialUsers={result.data.users} initialNextCursor={result.data.nextCursor} />
      ) : (
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view the user directory." icon="lock" />
        </section>
      )}
    </AppShell>
  );
}
