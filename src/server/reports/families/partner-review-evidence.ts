import type { ActorContext } from "@/server/authz/types";
import { getPartnerReview } from "@/server/partner-reviews/partner-review-service";
import { listPartnerReviewHeads } from "@/server/partner-reviews/partner-review-list-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Section 12: Partner Review Evidence - FINALIZED review versions only, Production/Compliance/
// Performance kept as three fully separate sections (never blended - Partner Reviews' own schema has
// no composite-score field either, so there is nothing to accidentally reuse). Bounded in two tiers:
// a bounded HEAD list (HEAD_PAGE_SIZE), then full per-review evidence detail for only the first
// DETAIL_FETCH_CAP of those heads - a small, fixed, disclosed cap (never an unbounded per-row detail
// fan-out).
const HEAD_PAGE_SIZE = 50;
const DETAIL_FETCH_CAP = 20;

export async function runPartnerReviewEvidenceReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const partnerRef = appliedFilters.partnerRef;
  const periodKey = appliedFilters.period;

  const headsResult = await listPartnerReviewHeads(actor, { limit: HEAD_PAGE_SIZE, partnerRef, periodKey });
  if (!headsResult.ok) return mapSourceError(headsResult);

  const finalizedHeads = headsResult.data.heads.filter((head) => head.currentFinalizedVersion !== null);
  const detailTargets = finalizedHeads.slice(0, DETAIL_FETCH_CAP);

  const details = await Promise.all(detailTargets.map((head) => getPartnerReview(actor, head.reviewRef, { version: head.currentFinalizedVersion! })));

  const rows: ReportRow[] = [];
  const production: ReportRow[] = [];
  const compliance: ReportRow[] = [];
  const performance: ReportRow[] = [];
  let withComplianceEvidenceCount = 0;
  let withPerformanceEvidenceCount = 0;
  let latestFinalizedAt: string | null = null;

  for (let i = 0; i < detailTargets.length; i++) {
    const head = detailTargets[i]!;
    const detail = details[i]!;
    if (!detail.ok) continue; // a since-changed/denied individual review is skipped, not fatal to the report
    const version = detail.data.selectedVersion;
    if (!version) continue;
    if (version.finalizedAt && (latestFinalizedAt === null || version.finalizedAt > latestFinalizedAt)) latestFinalizedAt = version.finalizedAt;

    const hasCompliance = version.snapshot.compliance.assignments.length > 0;
    const hasPerformance = version.snapshot.performance.records.length > 0;
    if (hasCompliance) withComplianceEvidenceCount++;
    if (hasPerformance) withPerformanceEvidenceCount++;

    rows.push({ reviewRef: head.reviewRef, partnerDisplayName: head.partnerDisplayName, periodKey: head.periodKey, finalizedVersion: head.currentFinalizedVersion, finalizedAt: version.finalizedAt ?? null, hasComplianceEvidence: hasCompliance, hasPerformanceEvidence: hasPerformance });
    production.push({ reviewRef: head.reviewRef, partnerDisplayName: head.partnerDisplayName, assignmentsIncluded: version.snapshot.production.assignments.length });
    compliance.push({ reviewRef: head.reviewRef, partnerDisplayName: head.partnerDisplayName, assignmentsIncluded: version.snapshot.compliance.assignments.length });
    performance.push({ reviewRef: head.reviewRef, partnerDisplayName: head.partnerDisplayName, recordCount: version.snapshot.performance.records.length });
  }

  const truncated = headsResult.data.nextCursor !== null || finalizedHeads.length > DETAIL_FETCH_CAP;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "partner_review_evidence",
      generatedAt,
      evidenceCutoff: latestFinalizedAt ?? generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listPartnerReviewHeads)", note: partnerRef ? "Scoped to the requested Partner." : "Every actor-scoped, FINALIZED Partner Review head." },
      metrics: { finalizedReviewCount: finalizedHeads.length, withComplianceEvidenceCount, withPerformanceEvidenceCount },
      rows,
      sections: { production, compliance, performance },
      extraLimitations: finalizedHeads.length > DETAIL_FETCH_CAP ? [`Full Production/Compliance/Performance evidence is included for only the first ${DETAIL_FETCH_CAP} of ${finalizedHeads.length} finalized reviews in scope (a fixed, disclosed cap - never an unbounded per-review detail fan-out); the remainder are not represented in this run.`] : [],
      truncated,
      rowCount: rows.length,
      provenance: [{ sourceModule: "partner_reviews", sourceFunction: "listPartnerReviewHeads", recordCount: headsResult.data.heads.length }, { sourceModule: "partner_reviews", sourceFunction: "getPartnerReview", recordCount: rows.length, scanned: detailTargets.length }],
    }),
  };
}
