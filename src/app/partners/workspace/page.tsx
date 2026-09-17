import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { PartnersWorkspace } from "@/features/partners/PartnersWorkspace";
import { resolveRequestActor } from "@/server/partners/http";
import { listPartners } from "@/server/partners/partner-service";

const TABS = [
  { label: "Overview", href: "/partners" },
  { label: "Workspace", href: "/partners/workspace" },
];

const INITIAL_LIMIT = 10;

export default async function PartnersWorkspacePage() {
  const actor = await resolveRequestActor();
  const result = await listPartners(actor, { limit: INITIAL_LIMIT });

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">RELATIONSHIPS / WORKSPACE</div>
          <h1>Partners workspace</h1>
          <p>Search, filter and act on every Partner you&rsquo;re authorized to see.</p>
        </div>
      </div>

      <ModuleTabs tabs={TABS} />

      {result.ok ? (
        <PartnersWorkspace initialPartners={result.data.partners} initialNextCursor={result.data.nextCursor} />
      ) : (
        <section className="panel">
          <EmptyState title="Access denied" description="You don&rsquo;t have permission to view Partners data." icon="lock" />
        </section>
      )}
    </AppShell>
  );
}
