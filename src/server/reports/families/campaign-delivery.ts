import { listAssignments } from "@/server/assignments/assignment-service";
import { isAssignmentOverdue } from "@/server/assignments/overdue";
import type { ActorContext } from "@/server/authz/types";
import { getCampaign } from "@/server/campaigns/campaign-service";
import { listContent } from "@/server/content/content-service";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Section 12: Campaign Delivery - sources Campaigns + Assignments + Content, each through its own
// already actor-scoped, already-bounded list function. No Firestore collection is ever touched
// directly and no source module's own authorization/record-scope rule is re-implemented here - a
// denial from listAssignments/listContent (e.g. the actor's scope excludes the requested Campaign)
// propagates straight through as this report's own denial.
const ASSIGNMENT_PAGE_SIZE = 100;
const CONTENT_PAGE_SIZE = 100;

export async function runCampaignDeliveryReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const campaignRef = appliedFilters.campaignRef;
  const platform = appliedFilters.platform;
  const status = appliedFilters.status as "DRAFT" | "ASSIGNED" | "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | undefined;

  let campaignName: string | null = null;
  if (campaignRef) {
    const campaign = await getCampaign(actor, campaignRef);
    if (!campaign.ok) return mapSourceError(campaign);
    campaignName = campaign.data.name;
  }

  const [assignmentsResult, contentResult] = await Promise.all([
    listAssignments(actor, { limit: ASSIGNMENT_PAGE_SIZE, campaignRef, platform, status }),
    listContent(actor, { limit: CONTENT_PAGE_SIZE, campaignRef }),
  ]);
  if (!assignmentsResult.ok) return mapSourceError(assignmentsResult);
  if (!contentResult.ok) return mapSourceError(contentResult);

  const assignments = assignmentsResult.data.assignments;
  const content = contentResult.data.content;
  const now = generatedAt;

  const completedAssignmentCount = assignments.filter((a) => a.status === "COMPLETED").length;
  const overdueAssignmentCount = assignments.filter((a) => isAssignmentOverdue(a, now)).length;
  const contentApprovedCount = content.filter((c) => c.status === "APPROVED").length;
  const contentUnderReviewCount = content.filter((c) => c.status === "UNDER_REVIEW" || c.status === "REVISION_REQUESTED").length;

  const assignmentRows: ReportRow[] = assignments.map((a) => ({
    assignmentRef: a.assignmentRef,
    campaignName: a.campaignName,
    partnerDisplayName: a.partnerDisplayName,
    status: a.status,
    dueAt: a.brief.dueAt,
    overdue: isAssignmentOverdue(a, now),
  }));

  const rows: ReportRow[] = [
    ...assignmentRows,
    ...content.map((c) => ({ contentRef: c.contentRef, campaignName: c.campaignName, partnerDisplayName: c.partnerDisplayName, status: c.status, dueAt: c.dueAt, approvedAt: c.approvedAt })),
  ];

  const truncated = assignmentsResult.data.nextCursor !== null || contentResult.data.nextCursor !== null;

  return {
    ok: true,
    data: buildReportResult({
      reportId: "campaign_delivery",
      generatedAt,
      evidenceCutoff: generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listAssignments/listContent)", note: campaignName ? `Scoped to Campaign "${campaignName}".` : "Scoped to every Campaign the actor's own grants permit." },
      metrics: { assignmentCount: assignments.length, completedAssignmentCount, overdueAssignmentCount, contentApprovedCount, contentUnderReviewCount },
      rows,
      // Bug class B fix: this row projection previously kept only contentRef (a raw internal ref) with
      // no resolved display-name sibling at all - ContentDto already carries both campaignName and
      // partnerDisplayName (used two lines above for the combined `rows` array; simply not copied into
      // this section's own row shape), so this is exactly the "row already has the data, just wasn't
      // projecting it" class of gap.
      sections: { assignments: assignmentRows, content: content.map((c) => ({ partnerDisplayName: c.partnerDisplayName, campaignName: c.campaignName, status: c.status, dueAt: c.dueAt, approvedAt: c.approvedAt, contentRef: c.contentRef })) },
      truncated,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "assignments", sourceFunction: "listAssignments", recordCount: assignments.length },
        { sourceModule: "content", sourceFunction: "listContent", recordCount: content.length },
      ],
    }),
  };
}
