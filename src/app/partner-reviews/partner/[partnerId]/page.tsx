import { PartnerHistoryPage } from "@/features/partner-reviews/PartnerHistoryPage";
import { parseHistoryTab } from "@/server/partner-reviews/ui-params";

// Step 13B: thin wrapper - the whole page is the one shared PartnerHistoryPage. `partnerId` is the canonical
// partnerRef (same convention as /partners/[partnerId] and /analytics/partner/[partnerId]); `?month=` and
// `?until=` (YYYY-MM) are handed over RAW and validated server-side; `?tab=` selects the local section.
export default async function PartnerHistoryRoute({
  params,
  searchParams,
}: {
  params: Promise<{ partnerId: string }>;
  searchParams: Promise<{ month?: string | string[]; until?: string | string[]; tab?: string | string[] }>;
}) {
  const { partnerId } = await params;
  const { month, until, tab } = await searchParams;
  return <PartnerHistoryPage partnerId={decodeURIComponent(partnerId)} tab={parseHistoryTab(tab)} month={month} until={until} />;
}
