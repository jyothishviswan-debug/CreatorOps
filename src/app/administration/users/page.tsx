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

export default function AdministrationUsersPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">SYSTEM GOVERNANCE</div>
          <h1>Users</h1>
          <p>Registered accounts and their assigned roles.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      <WorkspaceView workspace={getAdministrationWorkspace("users")} />
    </AppShell>
  );
}
