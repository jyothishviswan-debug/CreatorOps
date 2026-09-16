import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { DiscoveryWorkspace } from "@/features/discovery/DiscoveryWorkspace";
import { resolveRequestActor } from "@/server/discovery/http";
import { listLeads } from "@/server/discovery/lead-service";

const TABS = [
  { label: "Overview", href: "/discovery" },
  { label: "Workspace", href: "/discovery/leads" },
];

const INITIAL_LIMIT = 10;

export default async function DiscoveryLeadsPage() {
  const actor = await resolveRequestActor();
  const result = await listLeads(actor, { limit: INITIAL_LIMIT });

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">FIND &amp; ONBOARD</div>
          <h1>Discovery</h1>
          <p>Move the right prospects from first contact to partner.</p>
        </div>
        <div className="actions">
          <Link href="/discovery/new" className="btn primary">
            + Add lead
          </Link>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      {result.ok ? (
        <DiscoveryWorkspace initialLeads={result.data.leads} initialNextCursor={result.data.nextCursor} />
      ) : (
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view the Discovery workspace." />
        </section>
      )}
    </AppShell>
  );
}
