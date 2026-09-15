import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { DetailView } from "@/ui/DetailView";
import { getPartnerReviewDetail } from "@/features/partner-reviews/fixtures";

export default async function PartnerReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  const detail = getPartnerReviewDetail(reviewId);
  if (!detail) notFound();

  return (
    <AppShell>
      <DetailView moduleLabel="Partner Reviews" workspaceHref="/partner-reviews" detail={detail} />
    </AppShell>
  );
}
