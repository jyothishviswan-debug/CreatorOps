import { PartnerReviewsOverviewPage } from "@/features/partner-reviews/PartnerReviewsOverviewPage";
import { parseMonthParam } from "@/server/partner-reviews/ui-params";

// Step 13B: thin wrapper - the whole page is the one shared PartnerReviewsOverviewPage. `month` is
// handed over RAW and validated server-side (`YYYY-MM`); without it the page defaults to the latest
// review month in authorized scope, never the (probably empty) current calendar month.
export default async function PartnerReviewsOverviewRoute({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const { month } = await searchParams;
  return <PartnerReviewsOverviewPage month={parseMonthParam(month)} />;
}
