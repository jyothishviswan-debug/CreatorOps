import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getCampaignDetail } from "@/features/campaigns/fixtures";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const detail = getCampaignDetail(campaignId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Campaigns" workspaceHref="/campaigns" detail={detail} />
    </AppShell>
  );
}
