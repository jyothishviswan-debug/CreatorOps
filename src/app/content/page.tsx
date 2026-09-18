import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { ContentWorkspace } from "@/features/content/ContentWorkspace";
import { resolveRequestActor } from "@/server/content/http";
import { listContent } from "@/server/content/content-service";

export default async function ContentPage() {
  const actor = await resolveRequestActor();
  // Same service-layer-gate-before-any-read shape as Assignments'/
  // Campaigns' own page component (Step 10B's own precedent) - a denied
  // actor never causes a Content read to happen at all.
  const initial = await listContent(actor, { limit: 10 });

  if (!initial.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">PLAN &amp; DELIVER</div>
            <h1>Content</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Content data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PLAN &amp; DELIVER</div>
          <h1>Content</h1>
          <p>Production, review-policy, submission and publication evidence.</p>
        </div>
      </div>

      <ContentWorkspace initialContent={initial.data.content} initialNextCursor={initial.data.nextCursor} />
    </AppShell>
  );
}
