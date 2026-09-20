// Step 12E: the ONE server page implementation behind
// /analytics/partner/[partnerId]. Mirrors PlatformAnalyticsPage / the Overview
// shell exactly: AppShell > `ov-page` > head + the shared tab row (all through
// AnalyticsPageShell), the same "Access denied" EmptyState pattern for an actor
// without Analytics access.
//
// Step 12F: the tab row is the ONE shared six-tab Analytics row; this drill-down
// is not a tab of its own, so the row marks Partners as its parent / current
// context (ANALYTICS_TABS' `activePrefixes`). An optional, server-validated
// `?month=YYYY-MM` restricts the whole page to one reporting month (the Partners
// workspace's "Open full Partner Analytics" link carries it); without it the
// page is the unchanged all-imported-periods view. There is deliberately NO
// Import CTA and no import execution of any kind.
//
// An UNKNOWN Partner and an OUT-OF-SCOPE Partner render the identical neutral
// "Access denied" state (never a 404 for one and a denial for the other), and
// the state names no Partner.
import Link from "next/link";

import { resolveRequestActor } from "@/server/analytics/http";
import { getPartnerAnalyticsView } from "@/server/analytics/partner-view-service";

import { AnalyticsPageShell, AnalyticsAccessDenied } from "./AnalyticsPageShell";
import { AnalyticsPartnerView } from "./AnalyticsPartnerView";

export async function PartnerAnalyticsPage({ partnerId, platform, month }: { partnerId: string; platform: unknown; month?: unknown }) {
  const actor = await resolveRequestActor();
  const result = await getPartnerAnalyticsView(actor, partnerId, platform, month);

  if (!result.ok) {
    const partnerLevel = result.code === "not_found";
    return <AnalyticsAccessDenied title="Partner Analytics" description={partnerLevel ? "This Partner doesn't exist, or you don't have permission to view its analytics." : "You don't have permission to view Analytics data."} />;
  }

  const view = result.data;
  return (
    <AnalyticsPageShell
      title={`${view.partner.displayName} · Analytics`}
      description="Source-reported performance for this Partner across its authorized platform accounts, content and reporting periods."
      actions={
        <div className="actions">
          <Link href="/analytics" className="btn">
            Analytics Overview
          </Link>
          <Link href="/analytics/instagram" className="btn">
            Instagram Analytics
          </Link>
          <Link href="/analytics/youtube" className="btn">
            YouTube Analytics
          </Link>
          <Link href={view.links.explorerContentHref} className="btn">
            Data Explorer
          </Link>
          <Link href={view.links.profileHref} className="btn ghost">
            View Partner profile
          </Link>
        </div>
      }
    >
      <AnalyticsPartnerView view={view} />
    </AnalyticsPageShell>
  );
}
