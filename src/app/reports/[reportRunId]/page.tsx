import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getReportRunDetail } from "@/features/reports/fixtures";

export default async function ReportRunDetailPage({
  params,
}: {
  params: Promise<{ reportRunId: string }>;
}) {
  const { reportRunId } = await params;
  const detail = getReportRunDetail(reportRunId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Reports" workspaceHref="/reports" detail={detail} />
    </AppShell>
  );
}
