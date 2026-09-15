import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getDiscoveryLeadDetail } from "@/features/discovery/fixtures";

export default async function DiscoveryLeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;
  const detail = getDiscoveryLeadDetail(leadId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Discovery" workspaceHref="/discovery/leads" detail={detail} />
    </AppShell>
  );
}
