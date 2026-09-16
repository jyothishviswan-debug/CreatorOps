import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { AdministrationAuditWorkspace } from "@/features/administration/AdministrationAuditWorkspace";
import { resolveRequestActor } from "@/server/administration/http";
import { listAuditEventsForReview } from "@/server/administration/audit-service";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

export default async function AdministrationAuditPage() {
  const actor = await resolveRequestActor();
  const result = await listAuditEventsForReview(actor, { limit: 20 });

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">SYSTEM GOVERNANCE</div>
          <h1>Audit</h1>
          <p>Directory and access history events.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      {result.ok ? (
        <AdministrationAuditWorkspace initialEvents={result.data.events} initialNextCursor={result.data.nextCursor} />
      ) : (
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view the audit trail." />
        </section>
      )}
    </AppShell>
  );
}
