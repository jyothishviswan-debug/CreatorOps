import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { administrationOverview } from "@/features/administration/fixtures";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

export default function AdministrationOverviewPage() {
  const o = administrationOverview;
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

        <ContextBanner icon="shield" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />
        <OverviewPanels panels={o.bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
