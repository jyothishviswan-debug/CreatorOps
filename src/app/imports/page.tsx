import { AppShell } from "@/ui/AppShell";
import { ImportCenterTabs } from "@/features/imports/ImportCenterTabs";

// Import Center Completion: the governed Choose Data -> Upload -> Preview
// -> Mapping (conditional) -> Review -> Import -> Results -> History flow.
// See docs/CREATOROPS_CONTINUITY.md for the full feature status.
export default function ImportsPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">ACT & REPORT</div>
          <h1>Import Center</h1>
          <p>Governed upload, review and import flow for external data.</p>
        </div>
      </div>

      <div className="grid">
        <section className="panel s12">
          <div className="panelhead">
            <h2>Import</h2>
          </div>
          <div className="panelbody">
            <ImportCenterTabs />
          </div>
        </section>
      </div>
    </AppShell>
  );
}
