import { PartnerReviewsWorkspacePage, type WorkspaceSearchParams } from "@/features/partner-reviews/PartnerReviewsWorkspacePage";

// Step 13B: thin wrapper - the whole page is the one shared PartnerReviewsWorkspacePage. Every search
// param is handed over RAW (any may repeat -> string[]); the trusted service parses and bounds them.
export default async function PartnerReviewsWorkspaceRoute({ searchParams }: { searchParams: Promise<WorkspaceSearchParams> }) {
  const params = await searchParams;
  return <PartnerReviewsWorkspacePage params={params} />;
}
