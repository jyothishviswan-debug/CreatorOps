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

export default function OperationsTasksPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">ACT & REPORT</div>
          <h1>Tasks</h1>
          <p>Open work across the programme.</p>
        </div>
      </div>
      <ModuleTabs tabs={TABS} />
      <WorkspaceView workspace={getOperationsWorkspace("tasks")} />
    </AppShell>
  );
}
