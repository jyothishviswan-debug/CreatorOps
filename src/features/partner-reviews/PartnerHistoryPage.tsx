// Step 13B: the ONE server implementation of /partner-reviews/partner/[partnerId]. `partnerId` is the canonical
// partnerRef. The trust chain (see partner-review-history-service.ts) applies the LIVE Partner's Record Scope
// FIRST; an UNKNOWN Partner and an OUT-OF-SCOPE Partner render the identical neutral access-denied state and
// name no Partner.
import { EmptyState } from "@/ui/States";
import { PlatformTrendGrid } from "@/features/analytics/AnalyticsPlatformView";
import { resolveRequestActor } from "@/server/partner-reviews/http";
import { getPartnerReviewHistory } from "@/server/partner-reviews/partner-review-history-service";
import { parseMonthParam, type HistoryTab, type RawParam } from "@/server/partner-reviews/ui-params";

import { buildPlatformTrend, platformsInHistory } from "./history-view-model";
import { PartnerHistoryView } from "./PartnerHistoryView";
import { PartnerReviewsDetailFrame } from "./PartnerReviewsPageShell";

export async function PartnerHistoryPage({ partnerId, tab, month, until }: { partnerId: string; tab: HistoryTab; month: RawParam; until: RawParam }) {
  const actor = await resolveRequestActor();
  const untilParam = parseMonthParam(until);
  const result = await getPartnerReviewHistory(actor, partnerId, { month: parseMonthParam(month), until: untilParam });

  if (!result.ok) {
    return (
      <PartnerReviewsDetailFrame>
        <section className="panel">
          <EmptyState title="Access denied" description="This Partner doesn't exist, or you don't have permission to view its review history." icon="lock" />
        </section>
      </PartnerReviewsDetailFrame>
    );
  }

  // One 12D PlatformTrendGrid per platform (native measures never combined), rendered here on the server.
  const trendCharts: Record<string, React.ReactNode> = {};
  for (const platform of platformsInHistory(result.data.rows)) {
    const trend = buildPlatformTrend(result.data.rows, platform);
    if (trend.series.length > 0) trendCharts[platform] = <PlatformTrendGrid trend={trend} />;
  }

  return (
    <PartnerReviewsDetailFrame>
      <PartnerHistoryView trendCharts={trendCharts} key={`${result.data.partner.partnerRef}|${result.data.month.selected ?? ""}|${untilParam.state === "valid" ? untilParam.month : ""}`} view={result.data} initialTab={tab} until={untilParam.state === "valid" ? untilParam.month : null} />
    </PartnerReviewsDetailFrame>
  );
}
