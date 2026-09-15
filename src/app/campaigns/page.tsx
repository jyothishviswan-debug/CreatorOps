import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { campaignsOverview } from "@/features/campaigns/fixtures";

export default function CampaignsOverviewPage() {
  const o = campaignsOverview;
  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">{o.eyebrow}</div>
            <h1>{o.title}</h1>
            <p>{o.description}</p>
          </div>
          <div className="actions">
            <Link href="/campaigns/new" className="btn primary">
              + Add campaign
            </Link>
          </div>
        </div>

        <ModuleTabs tabs={[{ label: "Overview", href: "/campaigns" }, { label: "Workspace", href: "/campaigns/workspace" }]} />

        <ContextBanner icon="flag" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />
        <OverviewPanels panels={o.bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
