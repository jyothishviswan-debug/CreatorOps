import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { reportsOverview } from "@/features/reports/fixtures";

export default function ReportsOverviewPage() {
  const o = reportsOverview;
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

        <ModuleTabs tabs={[{ label: "Overview", href: "/reports" }, { label: "Workspace", href: "/reports/workspace" }]} />

        <ContextBanner icon="layers" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />
        <OverviewPanels panels={o.bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
