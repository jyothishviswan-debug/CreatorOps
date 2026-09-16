import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { AdministrationAccess } from "@/features/administration/AdministrationAccess";
import { resolveRequestActor } from "@/server/administration/http";
import { listUsers } from "@/server/administration/users-service";
import { getEffectiveAccess } from "@/server/administration/effective-access-service";
import { getSensitiveGrants } from "@/server/administration/sensitive-grants-service";
import { ROLES, type Role } from "@/server/authz/roles";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

export default async function AdministrationAccessPage() {
  const actor = await resolveRequestActor();
  const [usersResult, sensitiveResults] = await Promise.all([listUsers(actor, { limit: 50 }), Promise.all(ROLES.map((role) => getSensitiveGrants(actor, role)))]);

  if (!usersResult.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">SYSTEM GOVERNANCE</div>
            <h1>Access</h1>
          </div>
        </div>
        <ModuleTabs tabs={TABS} />
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view access governance data." />
        </section>
      </AppShell>
    );
  }

  const sensitiveByRole = Object.fromEntries(ROLES.map((role, i) => [role, sensitiveResults[i]!.ok ? sensitiveResults[i]!.data.categories : []])) as Record<Role, string[]>;

  const firstUser = usersResult.data.users[0] ?? null;
  const effectiveAccessResult = firstUser ? await getEffectiveAccess(actor, firstUser.userRef) : null;

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">SYSTEM GOVERNANCE</div>
          <h1>Access</h1>
          <p>Scope and permission coverage across accounts.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      <AdministrationAccess
        initialUsers={usersResult.data.users}
        initialSensitiveByRole={sensitiveByRole}
        initialSelectedUserRef={firstUser?.userRef ?? null}
        initialEffectiveAccess={effectiveAccessResult?.ok ? effectiveAccessResult.data : null}
      />
    </AppShell>
  );
}
