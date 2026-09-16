import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { AdministrationAccess } from "@/features/administration/AdministrationAccess";
import { resolveRequestActor } from "@/server/administration/http";
import { getUser } from "@/server/administration/users-service";
import { getEffectiveAccess } from "@/server/administration/effective-access-service";
import { getSensitiveGrants } from "@/server/administration/sensitive-grants-service";
import { ROLES, type Role } from "@/server/authz/roles";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

export default async function AdministrationAccessPage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { user: requestedUserRef } = await searchParams;
  const actor = await resolveRequestActor();
  const sensitiveResults = await Promise.all(ROLES.map((role) => getSensitiveGrants(actor, role)));

  if (!sensitiveResults[0] || (sensitiveResults[0].ok === false && sensitiveResults[0].code === "unauthorized")) {
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
          <EmptyState title="Access denied" description="You don't have permission to view access governance data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const sensitiveByRole = Object.fromEntries(ROLES.map((role, i) => [role, sensitiveResults[i]!.ok ? sensitiveResults[i]!.data.categories : []])) as Record<Role, string[]>;

  // Search-first by design: nothing is preloaded until an admin looks
  // for someone, EXCEPT when deep-linked with a specific userRef (e.g.
  // from a user's own detail page) - that one user's data is fetched
  // server-side so landing here from a link has no data flash either.
  const [initialUserResult, initialEffectiveAccessResult] = requestedUserRef
    ? await Promise.all([getUser(actor, requestedUserRef), getEffectiveAccess(actor, requestedUserRef)])
    : [null, null];

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
        initialSensitiveByRole={sensitiveByRole}
        initialSelectedUser={initialUserResult?.ok ? initialUserResult.data : null}
        initialEffectiveAccess={initialEffectiveAccessResult?.ok ? initialEffectiveAccessResult.data : null}
      />
    </AppShell>
  );
}
