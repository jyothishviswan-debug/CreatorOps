import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { AnalyticsExplorerWorkspace } from "@/features/analytics/AnalyticsExplorerWorkspace";
import { collectChannelLabelRefs, collectContentLabelRefs } from "@/features/analytics/explorer-helpers";
import { canPerformAction } from "@/server/authz/capabilities";
import { requireAnalyticsExploreAccess } from "@/server/analytics/analytics-gate";
import { listAnalyticsSourceRecords } from "@/server/analytics/explorer-service";
import { resolveRequestActor } from "@/server/analytics/http";
import { resolveAnalyticsLabels, type AnalyticsLabelMaps } from "@/server/analytics/label-resolution";
import type { AnalyticsMatchState } from "@/server/analytics/types";

const TABS = [
  { label: "Overview", href: "/analytics" },
  { label: "Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];

const EMPTY_LABELS: AnalyticsLabelMaps = { content: {}, campaigns: {}, partners: {}, partnerAccounts: {}, batches: {} };
const MATCH_STATES: AnalyticsMatchState[] = ["MATCHED", "UNMATCHED", "AMBIGUOUS"];

type SearchParams = { recordKind?: string; matchState?: string; platform?: string; batchRef?: string };

export default async function AnalyticsExplorerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const actor = await resolveRequestActor();
  const gate = await requireAnalyticsExploreAccess(actor);

  if (!gate.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>Metric explorer</h1>
          </div>
        </div>
        <ModuleTabs tabs={TABS} />
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panelbody">
            <EmptyState title="Access denied" description="You don't have permission to view Analytics data." icon="lock" />
          </div>
        </section>
      </AppShell>
    );
  }

  const sp = await searchParams;
  const recordKind: "content" | "channel" = sp.recordKind === "channel" ? "channel" : "content";
  const matchState = MATCH_STATES.find((s) => s === sp.matchState);
  const platform = sp.platform || undefined;
  const batchRef = sp.batchRef || undefined;

  const listResult = await listAnalyticsSourceRecords(actor, { recordKind, limit: 20, matchState, platform, batchRef });

  const actorCanResolve = actor ? await canPerformAction(actor, "analytics", "manage_analytics_data") : false;

  const initialRecords = listResult.ok ? listResult.data.records : [];
  const initialNextCursor = listResult.ok ? listResult.data.nextCursor : null;

  const refs = recordKind === "content" ? collectContentLabelRefs(initialRecords as never) : collectChannelLabelRefs(initialRecords as never);
  const labelsResult = await resolveAnalyticsLabels(actor, refs);
  const initialLabels = labelsResult.ok ? labelsResult.data : EMPTY_LABELS;

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">MEASURE &amp; REVIEW</div>
          <h1>Metric explorer</h1>
          <p>Filter and inspect source-backed performance records across partners, platforms and periods.</p>
        </div>
      </div>

      <ModuleTabs tabs={TABS} />

      <AnalyticsExplorerWorkspace
        initialRecordKind={recordKind}
        initialRecords={initialRecords}
        initialNextCursor={initialNextCursor}
        initialFilters={{ matchState, platform, batchRef }}
        initialLabels={initialLabels}
        actorCanResolve={actorCanResolve}
      />
    </AppShell>
  );
}
