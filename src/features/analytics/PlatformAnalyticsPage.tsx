// Step 12D: the ONE server page implementation behind /analytics/instagram and
// /analytics/youtube (each route file is a thin wrapper that only names its
// normalized platform id). Mirrors src/app/analytics/page.tsx's own shell
// exactly: AppShell > `ov-page` > head + shared ModuleTabs, the same
// "Access denied" EmptyState pattern for an actor without Analytics access.
//
// There is deliberately NO reporting-period control: the accepted Overview has
// none and the Analytics list contract has no period filter, so none is
// invented here. There is deliberately NO Import CTA and no import execution
// of any kind - the header links only to Data Explorer (platform-filtered)
// and Import History; Import execution stays in Import Center.
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { resolveRequestActor } from "@/server/analytics/http";
import { getPlatformAnalyticsView } from "@/server/analytics/platform-view-service";
import { PLATFORM_VIEW_COPY, type PlatformViewId } from "@/server/analytics/platform-view-metrics";

import { AnalyticsPlatformView } from "./AnalyticsPlatformView";
import { ANALYTICS_TABS } from "./analytics-tabs";
import { platformExplorerHref } from "./platform-view-helpers";

export async function PlatformAnalyticsPage({ platform }: { platform: PlatformViewId }) {
  const actor = await resolveRequestActor();
  const result = await getPlatformAnalyticsView(actor, platform);
  const copy = PLATFORM_VIEW_COPY[platform];

  if (!result.ok) {
    // An unknown platform can never reach here (route files pass a literal),
    // but the service is authoritative: not_found/invalid -> 404, never a
    // rendered arbitrary platform.
    if (result.code === "not_found" || result.code === "invalid_input") notFound();

    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>{copy.title}</h1>
          </div>
        </div>
        <ModuleTabs tabs={ANALYTICS_TABS} />
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panelbody">
            <EmptyState title="Access denied" description="You don't have permission to view Analytics data." icon="lock" />
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="ov-page">
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>{copy.title}</h1>
            <p>{copy.description}</p>
          </div>
          <div className="actions">
            <Link href={platformExplorerHref(platform, "content")} className="btn">
              Open in Data Explorer
            </Link>
            <Link href="/analytics/import-history" className="btn">
              Import History
            </Link>
          </div>
        </div>

        <ModuleTabs tabs={ANALYTICS_TABS} />

        <AnalyticsPlatformView view={result.data} />
      </div>
    </AppShell>
  );
}
