import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui/PageCanvas";
import { ScopeLine } from "@/ui/LocalTabs";
import { Button } from "@/ui/Button";
import { KpiCard, KpiRow } from "@/ui/KpiCard";
import { Panel, PanelBody, PanelFoot, PanelHead, PanelGrid } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";

const ATTENTION = [
  { title: "Content awaiting review", detail: "12 submissions ready to inspect", count: "12" },
  { title: "Upcoming campaign deadlines", detail: "Due within the next 7 days", count: "4" },
  { title: "Vendor agreement renewal review", detail: "Ending this month", count: "2" },
];

const RANKINGS = [
  { region: "Kerala", value: 38 },
  { region: "Maharashtra", value: 29 },
  { region: "Tamil Nadu", value: 21 },
  { region: "Karnataka", value: 12 },
];

export default function DashboardPage() {
  return (
    <AppShell crumb="Dashboard">
      <PageHeader
        eyebrow="YOUR PROGRAMME AT A GLANCE"
        title="Dashboard"
        description="A clear path to what needs you next."
        actions={<Button variant="primary">New content</Button>}
      />
      <ScopeLine label="Fixture / sample state — no live account or data access" />

      <KpiRow>
        <KpiCard icon="users" label="Active partners" value="128" trend="Across 7 regions" />
        <KpiCard icon="flag" tone="blue" label="Live campaigns" value="12" trend="In execution" />
        <KpiCard icon="file" tone="green" label="Content items" value="342" trend="Planned and delivered" />
        <KpiCard icon="clock" tone="purple" label="Pending reviews" value="18" trend="Ready for a decision" />
      </KpiRow>

      <PanelGrid>
        <Panel span={7}>
          <PanelHead title="Needs your attention" description="Items with the nearest deadlines" />
          <PanelBody>
            {ATTENTION.map((item) => (
              <div className="attention" key={item.title}>
                <span className="alerttile">
                  <span aria-hidden>!</span>
                </span>
                <div className="grow">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </div>
                <span className="count">{item.count}</span>
                <span className="arrow">→</span>
              </div>
            ))}
          </PanelBody>
          <PanelFoot>
            <span>Fixture data · illustrative only</span>
          </PanelFoot>
        </Panel>

        <Panel span={5}>
          <PanelHead title="Regional contribution" description="Share of active partners by region" />
          <PanelBody>
            {RANKINGS.map((row) => (
              <div className="barrow" key={row.region}>
                <div className="barlabel">
                  <span>{row.region}</span>
                  <b>{row.value}%</b>
                </div>
                <div className="bar">
                  <i style={{ width: `${row.value}%` }} />
                </div>
              </div>
            ))}
          </PanelBody>
        </Panel>
      </PanelGrid>

      <PanelGrid>
        <Panel span={12}>
          <PanelHead title="Content status" description="Completed, submitted, and planned this period" />
          <PanelBody>
            <div className="actions">
              <Pill>Completed · 219</Pill>
              <Pill tone="orange">Submitted · 72</Pill>
              <Pill tone="gray">Planned · 51</Pill>
            </div>
          </PanelBody>
        </Panel>
      </PanelGrid>
    </AppShell>
  );
}
