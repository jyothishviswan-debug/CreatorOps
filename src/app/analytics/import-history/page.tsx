import Link from "next/link";

import { AnalyticsImportHistoryWorkspace } from "@/features/analytics/AnalyticsImportHistoryWorkspace";
import { AnalyticsAccessDenied, AnalyticsPageShell } from "@/features/analytics/AnalyticsPageShell";
import { requireAnalyticsExploreAccess, requireAnalyticsManageAccess, requireImportsModuleAccess } from "@/server/analytics/analytics-gate";
import { listAnalyticsImportBatches } from "@/server/analytics/import-history-service";
import { resolveRequestActor } from "@/server/analytics/http";

export default async function AnalyticsImportHistoryPage() {
  const actor = await resolveRequestActor();
  const gate = await requireAnalyticsExploreAccess(actor);

  if (!gate.ok) return <AnalyticsAccessDenied title="Import history" />;

  const [listResult, importsGate, manageGate] = await Promise.all([listAnalyticsImportBatches(actor, { limit: 20 }), requireImportsModuleAccess(actor), requireAnalyticsManageAccess(actor)]);
  const canSeeImportCta = importsGate.ok && manageGate.ok;

  const initialBatches = listResult.ok ? listResult.data.batches : [];
  const initialNextCursor = listResult.ok ? listResult.data.nextCursor : null;

  return (
    <AnalyticsPageShell
      title="Import history"
      description="Review past Analytics ingestion batches and their source quality."
      actions={
        canSeeImportCta ? (
          <div className="actions">
            <Link href="/imports?module=analytics" className="btn">
              Import data
            </Link>
          </div>
        ) : undefined
      }
    >
      <AnalyticsImportHistoryWorkspace initialBatches={initialBatches} initialNextCursor={initialNextCursor} />
    </AnalyticsPageShell>
  );
}
