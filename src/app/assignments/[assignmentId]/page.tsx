import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";
import { AssignmentDetail } from "@/features/assignments/AssignmentDetail";
import { resolveRequestActor } from "@/server/assignments/http";
import { getAssignment } from "@/server/assignments/assignment-service";

export default async function AssignmentDetailPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const actor = await resolveRequestActor();
  const result = await getAssignment(actor, assignmentId);

  if (!result.ok && result.code === "not_found") notFound();

  if (!result.ok) {
    return (
      <AppShell>
        <section className="panel">
          <EmptyState title="Access denied" description="You don't have permission to view this Assignment." icon="lock" />
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <AssignmentDetail initialAssignment={result.data} />
    </AppShell>
  );
}
