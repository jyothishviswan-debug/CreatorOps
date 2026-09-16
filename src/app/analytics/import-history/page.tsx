import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";

const TABS = [
  { label: "Overview", href: "/analytics" },
  { label: "Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];

export default function AnalyticsImportHistoryPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">MEASURE & REVIEW</div>
          <h1>Import history</h1>
          <p>Review past analytics ingestion batches and their source quality.</p>
        </div>
      </div>

      <ModuleTabs tabs={TABS} />

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="panelbody">
          <EmptyState
            title="Import history preview"
            description="Ingestion batch parsing and history are a later build step — this skeleton only proves the route and navigation."
            icon="chart"
          />
        </div>
      </div>
    </AppShell>
  );
}
