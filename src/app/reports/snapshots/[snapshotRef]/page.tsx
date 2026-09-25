import { notFound } from "next/navigation";

import { AppShell } from "@/ui/AppShell";
import { computeReportsPermissions, getFinalizedSnapshot, getReportDefinition } from "@/server/reports";
import { resolveRequestActor } from "@/server/reports/http";

import { formatDateTime } from "@/features/reports/copy";
import type { ReportResultLike } from "@/features/reports/result/ReportResultView";
import { ReportResultView } from "@/features/reports/result/ReportResultView";

type RouteParams = { params: Promise<{ snapshotRef: string }> };

// Step 19B section 15: read back ONE immutable finalized snapshot. getFinalizedSnapshot already
// enforces "visible only to the actor who finalized it" with a neutral not_found for anyone else
// (see snapshot-service.ts) - this page adds no broader visibility of its own.
export default async function SnapshotDetailPage({ params }: RouteParams) {
  const { snapshotRef } = await params;
  const actor = await resolveRequestActor();
  const permissions = await computeReportsPermissions(actor);
  if (!permissions.canView) notFound();

  const result = await getFinalizedSnapshot(actor, snapshotRef);
  if (!result.ok) notFound();
  const doc = result.data;
  const definition = getReportDefinition(doc.reportId);

  const resultLike: ReportResultLike = {
    generatedAt: doc.generatedAt,
    evidenceCutoff: doc.evidenceCutoff,
    appliedFilters: doc.appliedFilters,
    scopeSummary: doc.scopeSummary,
    metrics: doc.result.metrics,
    sections: doc.result.sections,
    limitations: doc.limitations,
    truncated: doc.truncated,
    rowCount: doc.rowCount,
    maxRows: doc.maxRows,
    provenance: doc.provenance,
  };

  return (
    <AppShell>
      <div className="head">
        <div>
          <div className="eyebrow">REPORTS / FINALIZED SNAPSHOT</div>
          <h1>{definition.title}</h1>
          <p>
            Finalized {formatDateTime(doc.createdAt)} · {doc.snapshotRef} · definition v{doc.definitionVersion}
          </p>
        </div>
      </div>

      <div className="banner">
        <span>
          <b>Immutable snapshot.</b> This is exactly the result that was finalized on {formatDateTime(doc.createdAt)} - it never changes, even if the live report would return something different today.
        </span>
      </div>

      <ReportResultView definition={definition} result={resultLike} viewerSafe={false} />
    </AppShell>
  );
}
