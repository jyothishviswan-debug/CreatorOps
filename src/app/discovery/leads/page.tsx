import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { WorkspaceView } from "@/ui/WorkspaceView";
import { discoveryOverview, discoveryWorkspace } from "@/features/discovery/fixtures";

export default function DiscoveryLeadsPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">{discoveryOverview.eyebrow}</div>
          <h1>{discoveryOverview.title}</h1>
          <p>{discoveryOverview.description}</p>
        </div>
        <div className="actions">
          <Link href="/discovery/new" className="btn primary">
            + Add lead
          </Link>
        </div>
      </div>

      <ModuleTabs tabs={[{ label: "Overview", href: "/discovery" }, { label: "Workspace", href: "/discovery/leads" }]} />

      <WorkspaceView workspace={discoveryWorkspace} basePath="/discovery" />
    </AppShell>
  );
}
