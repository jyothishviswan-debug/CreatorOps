import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { WorkspaceView } from "@/ui/WorkspaceView";
import { getOperationsWorkspace } from "@/features/operations/fixtures";

const TABS = [
  { label: "Overview", href: "/operations" },
  { label: "Tasks", href: "/operations/tasks" },
  { label: "Approvals", href: "/operations/approvals" },
  { label: "Reminders", href: "/operations/reminders" },
];

export default function OperationsApprovalsPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">ACT & REPORT</div>
          <h1>Approvals</h1>
          <p>Decisions waiting on you.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      <WorkspaceView workspace={getOperationsWorkspace("approvals")} />
    </AppShell>
  );
}
