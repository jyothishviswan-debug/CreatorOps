import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import type { OverviewPanelData } from "@/features/shared/types";
import { CampaignsHome } from "@/features/campaigns/CampaignsHome";
import { relativeTime } from "@/features/campaigns/format";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import { resolveRequestActor } from "@/server/campaigns/http";
import { listCampaigns } from "@/server/campaigns/campaign-service";
import type { CampaignListCursor } from "@/server/campaigns/firestore";

async function loadAllCampaigns(actor: Awaited<ReturnType<typeof resolveRequestActor>>): Promise<CampaignDto[] | null> {
  const campaigns: CampaignDto[] = [];
  let cursor: CampaignListCursor | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await listCampaigns(actor, { limit: 100, cursor });
    if (!result.ok) return null;
    campaigns.push(...result.data.campaigns);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return campaigns;
}

export default async function CampaignsOverviewPage() {
  const actor = await resolveRequestActor();
  const campaigns = await loadAllCampaigns(actor);

  if (!campaigns) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">PLAN &amp; DELIVER</div>
            <h1>Campaigns</h1>
          </div>
        </div>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view Campaigns data." icon="lock" />
        </section>
      </AppShell>
    );
  }

  const total = campaigns.length;
  const active = campaigns.filter((c) => c.status === "ACTIVE").length;

  const recentlyUpdated = [...campaigns].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 4);

  const statusLabels: Record<string, string> = { DRAFT: "Draft", PLANNED: "Planned", ACTIVE: "Active", PAUSED: "Paused", COMPLETED: "Completed", CANCELLED: "Cancelled", ARCHIVED: "Archived" };

  // Panel slots, kinds, spans and titles below are the approved layout,
  // kept exactly as supplied (docs/reference/CreatorOps_UI_Golden_Master.html's
  // OV_DATA.campaigns: top = campaignboard/donut/donut span 6+3+3; bottom =
  // checks/attention/activity/actions span 3 each; 4 KPIs). Step 9B.1's
  // explicit rule: a slot is filled with real data only where the
  // APPROVED SLOT'S OWN meaning genuinely is Campaign-owned - not merely
  // because a same-category Campaign-only signal could be invented for
  // it. Every approved slot here (Assigned Partners, Content completed,
  // Overdue content, Campaign Execution, Delivery State, Staffing
  // Readiness, Tracking Readiness, Execution Exceptions) is defined by
  // Content/Assignment/Staffing/Analytics-tracking specifics that don't
  // exist yet, so each keeps its exact slot/title/kind/span and renders a
  // truthful neutral "not yet available" state instead. Only "Active
  // campaigns" (Campaign lifecycle/status), "Recent Activity" (recent
  // Campaign history/activity) and "Quick Actions" (navigation, not a
  // data signal) are genuinely Campaign-owned as approved.
  const topPanels: OverviewPanelData[] = [
    {
      kind: "campaignboard",
      icon: "clock",
      title: "Campaign Execution",
      note: "Not yet available — tracking depends on the Content module, which is not built yet.",
      foot: "This panel will populate once Content is built.",
      span: 6,
      rows: [],
    },
    {
      kind: "donut",
      icon: "clock",
      title: "Delivery State",
      note: "Not yet available - depends on Content, which is not built yet.",
      foot: "This panel will populate once Content is built.",
      span: 3,
      total: 1,
      totalLabel: "Not available",
      segments: [{ label: "Not yet available", value: 0 }],
    },
    {
      kind: "donut",
      icon: "clock",
      title: "Staffing Readiness",
      note: "Not yet available - depends on Assignments, which is not built yet.",
      foot: "This panel will populate once Assignments is built.",
      span: 3,
      total: 1,
      totalLabel: "Not available",
      segments: [{ label: "Not yet available", value: 0 }],
    },
  ];

  const bottomPanels: OverviewPanelData[] = [
    {
      kind: "checks",
      icon: "clock",
      title: "Tracking Readiness",
      note: "Not yet available - tracking/source-link/reporting coverage depends on Content and Analytics, which are not built yet.",
      foot: "This panel will populate once Content and Analytics are built.",
      span: 3,
      rows: [{ label: "Not yet available", detail: "—", badge: "Not built" }],
    },
    {
      kind: "attention",
      icon: "clock",
      title: "Execution Exceptions",
      note: "Not yet available - depends on Content and Assignments, which are not built yet.",
      foot: "This panel will populate once Content and Assignments are built.",
      span: 3,
      rows: [{ title: "Not yet available", detail: "Depends on Content and Assignments", count: "—" }],
    },
    {
      kind: "activity",
      icon: "clock",
      title: "Recent Activity",
      note: "Most recently updated Campaigns in scope",
      foot: recentlyUpdated.length > 0 ? "Full history is on each Campaign's own page." : "No Campaign activity yet.",
      span: 3,
      rows: recentlyUpdated.map((campaign) => ({
        title: campaign.name,
        detail: `${statusLabels[campaign.status]?.toLowerCase() ?? campaign.status.toLowerCase()} · ${relativeTime(campaign.updatedAt)}`,
        href: `/campaigns/${campaign.campaignRef}`,
      })),
    },
    {
      kind: "actions",
      icon: "grid",
      title: "Quick Actions",
      note: "Continue from insight to action",
      foot: "Every action below navigates to a real screen.",
      span: 3,
      rows: [
        { label: "Campaign workspace", icon: "grid" },
        { label: "Add a campaign", icon: "plus", href: "/campaigns/new" },
        { label: "Review readiness", icon: "link" },
        { label: "Needs attention", icon: "alert" },
      ],
    },
  ];

  const initial = await listCampaigns(actor, { limit: 10 });
  const initialCampaigns = initial.ok ? initial.data.campaigns : [];
  const initialNextCursor = initial.ok ? initial.data.nextCursor : null;

  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">PLAN &amp; DELIVER</div>
            <h1>Campaigns</h1>
            <p>Programme-wide plans, targeting and default review policy for your Campaigns.</p>
          </div>
          <div className="actions">
            <Link href="/campaigns/new" className="btn primary">
              + Add campaign
            </Link>
          </div>
        </div>

        <CampaignsHome
          kpis={[
            { icon: "check", label: "Active campaigns", value: String(active), hint: "current period" },
            { icon: "users", label: "Assigned Partners", value: "—", hint: "Not yet available" },
            { icon: "brief", label: "Content completed", value: "—", hint: "Not yet available" },
            { icon: "alert", label: "Overdue content", value: "—", hint: "Not yet available" },
          ]}
          topPanels={topPanels}
          bottomPanels={bottomPanels}
          summary="What is happening, what needs attention, and where to act next."
          chips={["Real scoped emulator data", `${total} Campaign${total === 1 ? "" : "s"} in scope`]}
          initialCampaigns={initialCampaigns}
          initialNextCursor={initialNextCursor}
        />
      </div>
    </AppShell>
  );
}
