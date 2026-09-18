import { AppShell } from "@/ui/AppShell";
import { Icon } from "@/ui/icons";
import { Checklist } from "@/ui/Form";
import { ImportCenterPanel } from "@/features/imports/ImportCenterPanel";

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
        <section className="panel s8">
          <div className="panelhead">
            <h2>Analytics import</h2>
          </div>
          <div className="panelbody">
            <ImportCenterPanel />
          </div>
        </section>
        <section className="panel s4">
          <div className="panelhead">
            <h2>Governed import steps</h2>
          </div>
          <div className="panelbody">
            <Checklist>
              <li>
                <Icon name="check" /> Upload a source file
              </li>
              <li>
                <Icon name="check" /> Validate against canonical fields
              </li>
              <li>
                <Icon name="check" /> Review exceptions before committing
              </li>
              <li>
                <Icon name="check" /> Confirm the import run
              </li>
            </Checklist>
            <div className="scopebox">Illustrative sequence only — no parsing or import execution in this preview.</div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
