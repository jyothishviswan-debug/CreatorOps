// Content ported exactly from the golden master's OV_DATA.dashboard
// (docs/reference/CreatorOps_UI_Golden_Master.html), rendered with the
// "ov-" panel/kpi/donut/trend/stages/rankings components in src/ui/Overview.tsx.
// Sample labels normalized to canonical terminology (creator -> partner).
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui/PageCanvas";
import {
  ContextBanner,
  OverviewKpiRow,
  OverviewRow,
  OverviewPanel,
  DonutRing,
  TrendGrid,
  Stages,
  Rankings,
  AttentionRows,
  Events,
  ActionGrid,
} from "@/ui/Overview";

export default function DashboardPage() {
  return (
    <AppShell>
      <div className="ov-page">
        <PageHeader
          eyebrow="PORTFOLIO INTELLIGENCE"
          title="Dashboard"
          description="Your portfolio, delivery priorities and next decisions."
        />

        <ContextBanner
          icon="grid"
          title="Portfolio command center"
          description="What is happening, what needs attention, and where to act next."
          chips={["Authorized scope preview", "August 2026 sample"]}
        />

        <OverviewKpiRow
          items={[
            {
              icon: "users",
              label: "Active partners",
              value: "126",
              hint: "of 142 partners",
            },
            {
              icon: "brief",
              label: "Active campaigns",
              value: "18",
              hint: "across your portfolio",
            },
            {
              icon: "flag",
              label: "Content completed",
              value: "128",
              hint: "of 164 required",
            },
            {
              icon: "chart",
              label: "Needs attention",
              value: "11",
              hint: "actionable groups",
            },
          ]}
        />

        <OverviewRow>
          <OverviewPanel
            span={6}
            icon="brief"
            tone={0}
            title="Platform Performance"
            note="Native metrics · Apr–Aug 2026"
            foot="Instagram reach and YouTube views remain separate."
            link
          >
            <TrendGrid
              series={[
                {
                  label: "Instagram reach",
                  color: "#2878fa",
                  unit: "M",
                  values: [12.1, 14.2, 13.6, 16.8, 18.4],
                },
                {
                  label: "YouTube views",
                  color: "#8b4aff",
                  unit: "M",
                  values: [8.2, 9.4, 10.1, 11.6, 12.7],
                },
              ]}
            />
          </OverviewPanel>

          <OverviewPanel
            span={3}
            icon="check"
            tone={1}
            title="Delivery Health"
            note="164 required deliverables"
            foot="78% complete · 8 overdue deliverables need review."
            link
          >
            <DonutRing
              total={164}
              totalLabel="Total"
              healthPalette
              segments={[
                { label: "Completed", value: 128 },
                { label: "In progress", value: 20 },
                { label: "Not started", value: 16 },
              ]}
            />
          </OverviewPanel>

          <OverviewPanel
            span={3}
            icon="layers"
            tone={2}
            title="Discovery Pipeline"
            note="Cumulative stage reach"
            foot="7 of 68 leads converted · 10.3% conversion."
            link
          >
            <Stages
              rows={[
                { label: "Identified", value: 68 },
                { label: "Shortlisted", value: 42 },
                { label: "Outreach sent", value: 31 },
                { label: "In conversation", value: 17 },
                { label: "Converted", value: 7 },
              ]}
            />
          </OverviewPanel>
        </OverviewRow>

        <OverviewRow secondary>
          <OverviewPanel
            span={3}
            icon="users"
            tone={4}
            title="Top Partners"
            foot="Ranks use recorded interactions, not blended scores."
            link
          >
            <Rankings
              rows={[
                { name: "Nila Talks", value: "94,000", initials: "NT" },
                { name: "Local Decode", value: "82,000", initials: "LD" },
                { name: "Public Pulse", value: "71,000", initials: "PP" },
                { name: "South Lens", value: "65,000", initials: "SL" },
              ]}
            />
          </OverviewPanel>

          <OverviewPanel
            span={3}
            icon="alert"
            tone={3}
            title="Needs Attention"
            foot="Focus on the work that blocks the next step."
            link
          >
            <AttentionRows
              items={[
                {
                  icon: "alert",
                  title: "Overdue deliverables",
                  hint: "Review",
                  count: "8",
                },
                {
                  icon: "brief",
                  title: "Awaiting approval",
                  hint: "Review",
                  count: "6",
                },
                {
                  icon: "search",
                  title: "Discovery follow-ups",
                  hint: "Contact",
                  count: "3",
                },
                {
                  icon: "flag",
                  title: "Unstaffed campaign",
                  hint: "Assign",
                  count: "1",
                },
              ]}
            />
          </OverviewPanel>

          <OverviewPanel
            span={3}
            icon="clock"
            tone={0}
            title="Recent Activity"
            foot="Full history stays in the workspace."
            link
          >
            <Events
              items={[
                {
                  icon: "check",
                  title: "Campaign content approved",
                  detail: "Civic Voices · 12 min ago",
                },
                {
                  icon: "users",
                  title: "Partner profile completed",
                  detail: "Nila Talks · 35 min ago",
                },
                {
                  icon: "wallet",
                  title: "Invoice review requested",
                  detail: "Creator House · 1 hour ago",
                },
              ]}
            />
          </OverviewPanel>

          <OverviewPanel
            span={3}
            icon="grid"
            tone={2}
            title="Quick Actions"
            foot="Actions preview the destination; no records are changed."
          >
            <ActionGrid
              actions={[
                { label: "Review work", icon: "check" },
                { label: "Explore analytics", icon: "chart" },
                { label: "Open reports", icon: "file" },
                { label: "Open workspace", icon: "grid" },
              ]}
            />
          </OverviewPanel>
        </OverviewRow>
      </div>
    </AppShell>
  );
}
