import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { ContextBanner, OverviewKpiRow, OverviewPanels } from "@/ui/Overview";
import { vendorsOverview } from "@/features/vendors/fixtures";

export default function VendorsOverviewPage() {
  const o = vendorsOverview;
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
            <Link href="/vendors/new" className="btn primary">
              + Add vendor
            </Link>
          </div>
        </div>

        <ModuleTabs tabs={[{ label: "Overview", href: "/vendors" }, { label: "Workspace", href: "/vendors/workspace" }]} />

        <ContextBanner icon="brief" title={o.summary} description="What is happening, what needs attention, and where to act next." chips={["Authorized scope preview", "September 2026 sample"]} />

        <OverviewKpiRow items={o.kpis} />
        <OverviewPanels panels={o.topPanels} />
        <OverviewPanels panels={o.bottomPanels} secondary />
      </div>
    </AppShell>
  );
}
