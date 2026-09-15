import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { WorkspaceView } from "@/ui/WorkspaceView";
import { getAdministrationWorkspace } from "@/features/administration/fixtures";

const TABS = [
  { label: "Overview", href: "/administration" },
  { label: "Users", href: "/administration/users" },
  { label: "Access", href: "/administration/access" },
  { label: "Audit", href: "/administration/audit" },
];

export default function AdministrationAccessPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">SYSTEM GOVERNANCE</div>
          <h1>Access</h1>
          <p>Scope and permission coverage across accounts.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      <WorkspaceView workspace={getAdministrationWorkspace("access")} />
    </AppShell>
  );
}
