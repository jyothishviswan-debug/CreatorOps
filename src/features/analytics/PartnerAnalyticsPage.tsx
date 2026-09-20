// Step 12E: the ONE server page implementation behind
// /analytics/partner/[partnerId]. Mirrors PlatformAnalyticsPage / the Overview
// shell exactly: AppShell > `ov-page` > head + the shared ModuleTabs, the same
// "Access denied" EmptyState pattern for an actor without Analytics access.
//
// The Analytics tab bar is the SAME shared ANALYTICS_TABS (Overview | Instagram
// | YouTube | Data Explorer | Import History) - this drill-down is neither a tab
// nor a sidebar item, so no tab is marked current (ModuleTabs marks a tab only
// when the pathname equals its href). There is deliberately NO reporting-period
// control, NO Import CTA and no import execution of any kind.
//
// An UNKNOWN Partner and an OUT-OF-SCOPE Partner render the identical neutral
// "Access denied" state (never a 404 for one and a denial for the other), and
// the state names no Partner.
import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { resolveRequestActor } from "@/server/analytics/http";
import { getPartnerAnalyticsView } from "@/server/analytics/partner-view-service";

import { AnalyticsPartnerView } from "./AnalyticsPartnerView";
import { ANALYTICS_TABS } from "./analytics-tabs";

export async function PartnerAnalyticsPage({ partnerId, platform }: { partnerId: string; platform: unknown }) {
  const actor = await resolveRequestActor();
  const result = await getPartnerAnalyticsView(actor, partnerId, platform);

  if (!result.ok) {
    const partnerLevel = result.code === "not_found";
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>Partner Analytics</h1>
          </div>
        </div>
        <ModuleTabs tabs={ANALYTICS_TABS} />
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panelbody">
            <EmptyState
              title="Access denied"
              description={partnerLevel ? "This Partner doesn't exist, or you don't have permission to view its analytics." : "You don't have permission to view Analytics data."}
              icon="lock"
            />
          </div>
        </section>
      </AppShell>
    );
  }

  const view = result.data;
  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>{view.partner.displayName} · Analytics</h1>
            <p>Source-reported performance for this Partner across its authorized platform accounts, content and reporting periods.</p>
          </div>
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
        </div>

        <ModuleTabs tabs={ANALYTICS_TABS} />

        <AnalyticsPartnerView view={view} />
      </div>
    </AppShell>
  );
}
