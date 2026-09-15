import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { operationsOverview } from "@/features/operations/fixtures";

const TABS = [
  { label: "Overview", href: "/operations" },
  { label: "Tasks", href: "/operations/tasks" },
  { label: "Approvals", href: "/operations/approvals" },
  { label: "Reminders", href: "/operations/reminders" },
];

export default function OperationsOverviewPage() {
  const o = operationsOverview;
  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">{o.eyebrow}</div>
            <h1>{o.title}</h1>
            <p>{o.description}</p>
          </div>
        </div>

        <ModuleTabs tabs={TABS} />

        <ContextBanner icon="clock" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />
        <OverviewPanels panels={o.bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
