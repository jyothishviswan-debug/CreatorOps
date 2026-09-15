import { AppShell } from "@/ui/AppShell";
import { WorkspaceView } from "@/ui/WorkspaceView";
import { contentWorkspace } from "@/features/content/fixtures";

export default function ContentPage() {
  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">PLAN &amp; DELIVER</div>
          <h1>Content</h1>
          <p>Production, review-policy, submission and publication evidence.</p>
        </div>
      </div>

      <WorkspaceView workspace={contentWorkspace} basePath="/content" />
    </AppShell>
  );
}
