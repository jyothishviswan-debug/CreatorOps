import Link from "next/link";

import { AppShell } from "@/ui/AppShell";
import { ModuleTabs } from "@/ui/ModuleTabs";
import { EmptyState } from "@/ui/States";
import { AnalyticsImportHistoryWorkspace } from "@/features/analytics/AnalyticsImportHistoryWorkspace";
import { ANALYTICS_TABS } from "@/features/analytics/analytics-tabs";
import { requireAnalyticsExploreAccess, requireAnalyticsManageAccess, requireImportsModuleAccess } from "@/server/analytics/analytics-gate";
import { listAnalyticsImportBatches } from "@/server/analytics/import-history-service";
import { resolveRequestActor } from "@/server/analytics/http";

export default async function AnalyticsImportHistoryPage() {
  const actor = await resolveRequestActor();
  const gate = await requireAnalyticsExploreAccess(actor);

  if (!gate.ok) {
    return (
      <AppShell>
        <div className="head">
          <div>
            <div className="eyebrow">MEASURE &amp; REVIEW</div>
            <h1>Import history</h1>
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

  const [listResult, importsGate, manageGate] = await Promise.all([listAnalyticsImportBatches(actor, { limit: 20 }), requireImportsModuleAccess(actor), requireAnalyticsManageAccess(actor)]);
  const canSeeImportCta = importsGate.ok && manageGate.ok;

  const initialBatches = listResult.ok ? listResult.data.batches : [];
  const initialNextCursor = listResult.ok ? listResult.data.nextCursor : null;

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">MEASURE &amp; REVIEW</div>
          <h1>Import history</h1>
          <p>Review past Analytics ingestion batches and their source quality.</p>
        </div>
        {canSeeImportCta && (
          <div className="actions">
            <Link href="/imports?module=analytics" className="btn">
              Import data
            </Link>
          </div>
        )}
      </div>

      <ModuleTabs tabs={ANALYTICS_TABS} />

      <AnalyticsImportHistoryWorkspace initialBatches={initialBatches} initialNextCursor={initialNextCursor} />
    </AppShell>
  );
}
