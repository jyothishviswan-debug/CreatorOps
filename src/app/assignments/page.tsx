import { AppShell } from "@/ui/AppShell";
import { WorkspaceView } from "@/ui/WorkspaceView";
import { assignmentsWorkspace } from "@/features/assignments/fixtures";

export default function AssignmentsPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PLAN &amp; DELIVER</div>
          <h1>Assignments</h1>
          <p>Partner-specific obligations across active campaigns.</p>
        </div>
      </div>

      <WorkspaceView workspace={assignmentsWorkspace} basePath="/assignments" />
    </AppShell>
  );
}
