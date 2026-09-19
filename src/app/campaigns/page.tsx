import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import type { OverviewPanelData } from "@/features/shared/types";
import { CampaignsHome } from "@/features/campaigns/CampaignsHome";
import { approvedOfTotalLabel, deliveryStateUnavailableNote, exceptionsNote, lowerBoundLabel, toCampaignBoardRows, truncationNote } from "@/features/campaigns/execution-format";
import { relativeTime } from "@/features/campaigns/format";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import { resolveRequestActor } from "@/server/campaigns/http";
import { listCampaigns } from "@/server/campaigns/campaign-service";
import type { CampaignListCursor } from "@/server/campaigns/firestore";
import { buildExecutionExceptionCategories, getCampaignExecutionOverview, type CampaignExecutionOverview } from "@/server/campaigns/execution-integration-service";

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

  // Step 12C: the execution-integration read model behind every
  // previously-placeholder slot below (Assigned Partners/Content
  // completed/Overdue content KPIs; Campaign Execution/Delivery State/
  // Tracking Readiness/Execution Exceptions panels) - see
  // src/server/campaigns/execution-integration-service.ts's own header
  // comment for the full composition. A denied/failed result here can
  // only happen if requireCampaignsFeatureAccess itself would also have
  // failed loadAllCampaigns above (same gate) - `execution` is therefore
  // effectively always populated whenever this page renders past the
  // access-denied branch, but the fallback below stays honest (a neutral
  // "not yet available" render, never a fabricated number) rather than
  // assuming that can never happen.
  const executionResult = await getCampaignExecutionOverview(actor);
  const execution: CampaignExecutionOverview | null = executionResult.ok ? executionResult.data : null;

  // Panel slots, kinds, spans and titles below are the approved layout,
  // kept exactly as supplied (docs/reference/CreatorOps_UI_Golden_Master.html's
  // OV_DATA.campaigns: top = campaignboard/donut/donut span 6+3+3; bottom =
  // checks/attention/activity/actions span 3 each; 4 KPIs). Step 9B.1's
  // explicit rule: a slot is filled with real data only where the
  // APPROVED SLOT'S OWN meaning genuinely is Campaign-owned. Step 12C
  // wires the Content/Assignment/Analytics-owned slots (Assigned
  // Partners, Content completed, Overdue content, Campaign Execution,
  // Delivery State, Tracking Readiness, Execution Exceptions) to real
  // composed execution data now that those domains exist - see
  // execution-integration-service.ts. Staffing Readiness has no canonical
  // staffing-target concept anywhere in this codebase and stays
  // permanently, honestly unavailable (same precedent as Analytics'
  // unsupported Reach/Shares metrics) - only "Active campaigns", "Recent
  // Activity" and "Quick Actions" were already genuinely Campaign-owned.
  //
  // Step 12C.2: when ANY contributing Campaign has more obligations than the
  // trusted read's documented bound (`execution.truncated`), every
  // portfolio figure below is only a lower bound. Nothing exact-looking is
  // derived from that incomplete denominator: counts gain a "+" suffix,
  // per-Campaign percentages/rings and the Delivery State shares become the
  // neutral "not available" form, and the truncation is stated in the
  // existing note slots. Non-truncated numbers are exactly as before - see
  // src/features/campaigns/execution-format.ts (pure, unit-tested).
  const executionTruncated = execution?.truncated ?? false;
  const truncatedCampaignCount = execution?.truncatedCampaignCount ?? 0;
  const deliveryStateTotal = execution && !executionTruncated ? execution.deliveryState.completed + execution.deliveryState.inProgress + execution.deliveryState.notStarted : 0;

  const executionExceptionCategories = execution ? buildExecutionExceptionCategories(execution.executionExceptions, executionTruncated) : [];

  const topPanels: OverviewPanelData[] = [
    {
      kind: "campaignboard",
      icon: "clock",
      title: "Campaign Execution",
      note:
        execution && execution.perCampaignExecution.length > 0
          ? [`${execution.perCampaignExecution.length} active Campaign${execution.perCampaignExecution.length === 1 ? "" : "s"} with assigned obligations`, truncationNote(truncatedCampaignCount)].filter(Boolean).join(" · ")
          : "No active Campaign has any assigned obligations yet.",
      foot: "Approved / assigned obligations",
      span: 6,
      rows: execution ? toCampaignBoardRows(execution.perCampaignExecution) : [],
    },
    {
      kind: "donut",
      icon: "clock",
      title: "Delivery State",
      note: executionTruncated
        ? deliveryStateUnavailableNote(truncatedCampaignCount)!
        : deliveryStateTotal > 0
          ? `${deliveryStateTotal} obligation${deliveryStateTotal === 1 ? "" : "s"} across active Campaigns`
          : "No execution obligations yet across active Campaigns.",
      foot: "Overdue is a separate date condition, not a lifecycle state.",
      span: 3,
      total: deliveryStateTotal > 0 ? deliveryStateTotal : 1,
      totalLabel: deliveryStateTotal > 0 ? "Obligations" : "Not available",
      segments:
        deliveryStateTotal > 0
          ? [
              { label: "Completed", value: execution!.deliveryState.completed },
              { label: "In progress", value: execution!.deliveryState.inProgress },
              { label: "Not started", value: execution!.deliveryState.notStarted },
            ]
          : [{ label: "Not yet available", value: 0 }],
    },
    {
      kind: "donut",
      icon: "clock",
      title: "Staffing Readiness",
      // Permanently unavailable by design, not a gap - no canonical
      // staffing target exists anywhere in this codebase's schema for
      // Campaigns to compare against (never a requiredPartnerCount field
      // invented for this). Same honest-unavailable precedent as
      // Analytics' own unsupported Reach/Shares metrics.
      note: "No canonical staffing target is configured for Campaigns.",
      foot: "No canonical staffing target is configured for Campaigns.",
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
      note: "Aggregated across every active Campaign in scope.",
      foot: "Reporting eligibility is not defined by the Analytics readiness data available today.",
      span: 3,
      rows: execution
        ? [execution.trackingReadiness.trackingConfiguredRow, execution.trackingReadiness.sourceLinksCompleteRow, execution.trackingReadiness.reportingEligibleRow, execution.trackingReadiness.campaignsUnstaffedRow]
        : [{ label: "Not yet available", detail: "—", badge: "Not built" }],
    },
    {
      kind: "attention",
      icon: "alert",
      title: "Execution Exceptions",
      note: exceptionsNote(
        executionExceptionCategories.map((c) => c.count),
        executionTruncated,
      ),
      foot: "Unavailable values must not appear as zero.",
      span: 3,
      rows: executionExceptionCategories.map((c) => ({ title: c.title, detail: c.detail, count: c.countLabel })),
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

  const executionExceptionLinks = Object.fromEntries(executionExceptionCategories.map((c) => [c.title, c.href]));

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
            { icon: "users", label: "Assigned Partners", value: execution ? lowerBoundLabel(execution.distinctAssignedPartnerCount, executionTruncated) : "—", hint: execution ? "distinct Partners" : "Not yet available" },
            {
              icon: "brief",
              label: "Content completed",
              value: execution ? approvedOfTotalLabel(execution.approvedObligations, execution.totalObligations, executionTruncated) : "—",
              hint: execution ? "assigned obligations approved" : "Not yet available",
            },
            { icon: "alert", label: "Overdue content", value: execution ? lowerBoundLabel(execution.overdueObligations, executionTruncated) : "—", hint: execution ? "needs attention" : "Not yet available" },
          ]}
          topPanels={topPanels}
          bottomPanels={bottomPanels}
          executionExceptionLinks={executionExceptionLinks}
          summary="What is happening, what needs attention, and where to act next."
          chips={["Real scoped emulator data", `${total} Campaign${total === 1 ? "" : "s"} in scope`]}
          initialCampaigns={initialCampaigns}
          initialNextCursor={initialNextCursor}
        />
      </div>
    </AppShell>
  );
}
