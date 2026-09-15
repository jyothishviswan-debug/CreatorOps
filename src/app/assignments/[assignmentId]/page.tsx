import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getAssignmentDetail } from "@/features/assignments/fixtures";

export default async function AssignmentDetailPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  const detail = getAssignmentDetail(assignmentId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Assignments" workspaceHref="/assignments" detail={detail} />
    </AppShell>
  );
}
