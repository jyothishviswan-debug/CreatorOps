import { notFound } from "next/navigation";

import { PartnerReviewDetailPage } from "@/features/partner-reviews/PartnerReviewDetailPage";
import { parseDetailTab, parseVersionParam } from "@/server/partner-reviews/ui-params";

// Step 13B: thin wrapper. `reviewRef` is the deterministic review identity (`pr_...`); `?tab=` and `?version=`
// are URL state, validated server-side (an unusable value falls back to the default and says so).
export default async function PartnerReviewDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ reviewRef: string }>;
  searchParams: Promise<{ tab?: string | string[]; version?: string | string[] }>;
}) {
  const { reviewRef } = await params;
  const { tab, version } = await searchParams;
  const page = await PartnerReviewDetailPage({ reviewRef, tab: parseDetailTab(tab), version: parseVersionParam(version) });
  if (page === "not_found") notFound();
  return page;
}
