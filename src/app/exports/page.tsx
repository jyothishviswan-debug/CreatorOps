import { AppShell } from "@/ui/AppShell";
import { Icon } from "@/ui/icons";
import { Checklist } from "@/ui/Form";
import { EmptyState } from "@/ui/States";

export default function ExportsPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">ACT & REPORT</div>
          <h1>Export Center</h1>
          <p>Governed export flow and export history.</p>
        </div>
      </div>

      <div className="grid">
        <section className="panel s8">
          <div className="panelbody">
            <EmptyState
              title="No exports yet"
              description="Scoped export generation and history are a later build step — this skeleton only proves the route and navigation."
            />
          </div>
        </section>
        <section className="panel s4">
          <div className="panelhead">
            <h2>Governed export steps</h2>
          </div>
          <div className="panelbody">
            <Checklist>
              <li>
                <Icon name="check" /> Choose scope and fields
              </li>
              <li>
                <Icon name="check" /> Confirm access and sensitivity
              </li>
              <li>
                <Icon name="check" /> Generate the export file
              </li>
              <li>
                <Icon name="check" /> Record it in export history
              </li>
            </Checklist>
            <div className="scopebox">Illustrative sequence only — no export generation in this preview.</div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
