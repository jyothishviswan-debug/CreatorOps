// Fixture data ported from the golden master's OV_DATA.dashboard.top/.bottom
// (docs/reference/CreatorOps_UI_Golden_Master.html), with sample labels
// normalized to canonical terminology (creator -> partner).
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui/PageCanvas";
import { ScopeLine } from "@/ui/LocalTabs";
import { KpiCard, KpiRow } from "@/ui/KpiCard";
import { Panel, PanelBody, PanelFoot, PanelHead, PanelGrid } from "@/ui/Panel";
import { ChartSummary, TrendLine, DonutRing, StageBars } from "@/ui/Charts";
import { AttentionList, ActivityList, RankList, ActionRow } from "@/ui/Lists";

export default function DashboardPage() {
  return (
    <AppShell crumb="Dashboard">
      <PageHeader
        eyebrow="PORTFOLIO INTELLIGENCE"
        title="Dashboard"
        description="Your portfolio, delivery priorities and next decisions."
      />
      <ScopeLine label="Authorized scope preview · August 2026 sample" />

      <KpiRow>
        <KpiCard icon="users" label="Active partners" value="126" trend="of 142 partners" />
        <KpiCard icon="flag" tone="blue" label="Active campaigns" value="18" trend="across your portfolio" />
        <KpiCard icon="file" tone="green" label="Content completed" value="128" trend="of 164 required" />
        <KpiCard icon="clock" tone="purple" label="Needs attention" value="11" trend="actionable groups" />
      </KpiRow>

      <PanelGrid>
        <Panel span={6}>
          <PanelHead title="Platform performance" description="Native metrics · Apr–Aug 2026" />
          <PanelBody>
            <ChartSummary value="18.4M" label="Instagram reach · +9.5% vs Jul" />
            <TrendLine points={[12.1, 14.2, 13.6, 16.8, 18.4]} color="var(--bright)" />
            <div style={{ height: 14 }} />
            <ChartSummary value="12.7M" label="YouTube views · +9.5% vs Jul" />
            <TrendLine points={[8.2, 9.4, 10.1, 11.6, 12.7]} color="#5a87bc" />
          </PanelBody>
          <PanelFoot>
            <span>Instagram reach and YouTube views remain separate.</span>
          </PanelFoot>
        </Panel>

        <Panel span={3}>
          <PanelHead title="Delivery health" description="164 required deliverables" />
          <PanelBody>
            <DonutRing
              total={164}
              totalLabel="Required"
              segments={[
                { label: "Completed", value: 128 },
                { label: "In progress", value: 20 },
                { label: "Not started", value: 16 },
              ]}
            />
          </PanelBody>
          <PanelFoot>
            <span>78% complete · 8 overdue deliverables need review.</span>
          </PanelFoot>
        </Panel>

        <Panel span={3}>
          <PanelHead title="Discovery pipeline" description="Cumulative stage reach" />
          <PanelBody>
            <StageBars
              rows={[
                { label: "Identified", value: 68 },
                { label: "Shortlisted", value: 42 },
                { label: "Outreach sent", value: 31 },
                { label: "In conversation", value: 17 },
                { label: "Converted", value: 7 },
              ]}
            />
          </PanelBody>
          <PanelFoot>
            <span>7 of 68 leads converted · 10.3% conversion.</span>
          </PanelFoot>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={3}>
          <PanelHead title="Top partners" description="Recorded interactions" />
          <PanelBody>
            <RankList
              items={[
                { rank: 1, name: "Nila Talks", value: "94,000" },
                { rank: 2, name: "Local Decode", value: "82,000" },
                { rank: 3, name: "Public Pulse", value: "71,000" },
                { rank: 4, name: "South Lens", value: "65,000" },
              ]}
            />
          </PanelBody>
          <PanelFoot>
            <span>Ranks use recorded interactions, not blended scores.</span>
          </PanelFoot>
        </Panel>

        <Panel span={3}>
          <PanelHead title="Needs attention" description="Actionable groups · may overlap" />
          <PanelBody>
            <AttentionList
              items={[
                { title: "Overdue deliverables", detail: "Review", count: "8" },
                { title: "Awaiting approval", detail: "Review", count: "6" },
                { title: "Discovery follow-ups", detail: "Contact", count: "3" },
                { title: "Unstaffed campaign", detail: "Assign", count: "1" },
              ]}
            />
          </PanelBody>
          <PanelFoot>
            <span>Focus on the work that blocks the next step.</span>
          </PanelFoot>
        </Panel>

        <Panel span={3}>
          <PanelHead title="Recent activity" description="Latest meaningful changes" />
          <PanelBody>
            <ActivityList
              items={[
                { title: "Campaign content approved", detail: "Civic Voices · 12 min ago" },
                { title: "Partner profile completed", detail: "Nila Talks · 35 min ago" },
                { title: "Invoice review requested", detail: "Creator House · 1 hour ago" },
                { title: "Discovery lead converted", detail: "South Lens · 3 hours ago" },
              ]}
            />
          </PanelBody>
          <PanelFoot>
            <span>Full history stays in the workspace.</span>
          </PanelFoot>
        </Panel>

        <Panel span={3}>
          <PanelHead title="Quick actions" description="Continue from insight to action" />
          <PanelBody>
            <ActionRow
              actions={[
                { label: "Review work", icon: "check" },
                { label: "Explore analytics", icon: "chart" },
                { label: "Open reports", icon: "file" },
                { label: "Open workspace", icon: "grid" },
              ]}
            />
          </PanelBody>
          <PanelFoot>
            <span>Actions preview the destination; no records are changed.</span>
          </PanelFoot>
        </Panel>
      </PanelGrid>
    </AppShell>
  );
}
