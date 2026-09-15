import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getPartnerDetail } from "@/features/partners/fixtures";

export default async function PartnerDetailPage({
  params,
}: {
  params: Promise<{ partnerId: string }>;
}) {
  const { partnerId } = await params;
  const detail = getPartnerDetail(partnerId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Partners" workspaceHref="/partners" detail={detail} />
    </AppShell>
  );
}
