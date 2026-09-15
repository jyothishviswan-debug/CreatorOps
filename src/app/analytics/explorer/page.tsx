import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";

const TABS = [
  { label: "Overview", href: "/analytics" },
  { label: "Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];

export default function AnalyticsExplorerPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">MEASURE &amp; REVIEW</div>
          <h1>Metric explorer</h1>
          <p>Filter and compare source-backed performance across partners, platforms and periods.</p>
        </div>
      </div>

      <ModuleTabs tabs={TABS} />

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panelbody">
          <EmptyState
            title="Explorer preview"
            description="The full filterable metric explorer is a later build step — this skeleton only proves the route and navigation."
          />
        </div>
      </div>
    </AppShell>
  );
}
