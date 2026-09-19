import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { CampaignDetail } from "@/features/campaigns/CampaignDetail";
import { resolveRequestActor } from "@/server/campaigns/http";
import { getCampaign } from "@/server/campaigns/campaign-service";
import { getCampaignDownstreamSummary } from "@/server/campaigns/detail-downstream-service";

export default async function CampaignDetailPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const actor = await resolveRequestActor();
  const result = await getCampaign(actor, campaignId);

  if (!result.ok && result.code === "not_found") notFound();

  if (!result.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Campaign." icon="lock" />
        </section>
      </AppShell>
    );
  }

  // Server-computed linked-records summary (Assignments/Content/Analytics +
  // whether the actor may create an Assignment here). A failure degrades
  // the cards to a truthful "not available" state, never blocks the page.
  const downstream = await getCampaignDownstreamSummary(actor, campaignId);

  return (
    <AppShell>
      <CampaignDetail initialCampaign={result.data} initialDownstream={downstream.ok ? downstream.data : null} />
    </AppShell>
  );
}
