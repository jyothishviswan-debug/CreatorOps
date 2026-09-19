import { describe, expect, it } from "vitest";

import { CAMPAIGN_STATUSES } from "./types";
import { aggregateDownstream, computeCanCreateAssignment, type DownstreamAssignmentInput, type DownstreamContentInput } from "./detail-downstream-service";

// Step 12C.1: pure aggregation behind Campaign Detail's Downstream
// availability cards - no Firestore, no scope logic of its own (the
// server function feeds it only already-scoped, bounded rows).

function assignment(assignmentRef: string, partnerRef: string, status: DownstreamAssignmentInput["status"]): DownstreamAssignmentInput {
  return { assignmentRef, partnerRef, status };
}
function thread(assignmentRef: string, status: DownstreamContentInput["status"]): DownstreamContentInput {
  return { assignmentRef, status };
}

describe("aggregateDownstream - Assignments", () => {
  it("is all zeros with no data", () => {
    expect(aggregateDownstream([], [])).toEqual({ total: 0, draftCount: 0, issuedCount: 0, distinctPartnerCount: 0, approvedCount: 0, underReviewCount: 0, revisionRequestedCount: 0 });
  });

  it("excludes CANCELLED, includes DRAFT in the total, and splits draft vs issued", () => {
    const result = aggregateDownstream(
      [
        assignment("a1", "p1", "DRAFT"),
        assignment("a2", "p2", "ASSIGNED"),
        assignment("a3", "p3", "ACCEPTED"),
        assignment("a4", "p4", "IN_PROGRESS"),
        assignment("a5", "p5", "COMPLETED"),
        assignment("a6", "p6", "CANCELLED"),
      ],
      [],
    );
    expect(result.total).toBe(5);
    expect(result.draftCount).toBe(1);
    expect(result.issuedCount).toBe(4);
    expect(result.draftCount + result.issuedCount).toBe(result.total);
  });

  it("counts distinct Partners over non-cancelled Assignments only", () => {
    const result = aggregateDownstream([assignment("a1", "p1", "ASSIGNED"), assignment("a2", "p1", "ASSIGNED"), assignment("a3", "p2", "DRAFT"), assignment("a4", "p3", "CANCELLED")], []);
    expect(result.distinctPartnerCount).toBe(2);
  });
});

describe("aggregateDownstream - Content", () => {
  const live = [assignment("a1", "p1", "IN_PROGRESS"), assignment("a2", "p2", "IN_PROGRESS"), assignment("a3", "p3", "IN_PROGRESS"), assignment("a4", "p4", "IN_PROGRESS")];

  it("counts approved / under-review / revision-requested canonical threads", () => {
    const result = aggregateDownstream(live, [thread("a1", "APPROVED"), thread("a2", "UNDER_REVIEW"), thread("a3", "REVISION_REQUESTED"), thread("a4", "OPEN")]);
    expect(result.approvedCount).toBe(1);
    expect(result.underReviewCount).toBe(1);
    expect(result.revisionRequestedCount).toBe(1);
  });

  it("ignores threads whose Assignment is CANCELLED or not visible", () => {
    const result = aggregateDownstream([assignment("a1", "p1", "CANCELLED"), assignment("a2", "p2", "ASSIGNED")], [thread("a1", "APPROVED"), thread("a2", "UNDER_REVIEW"), thread("not-visible", "APPROVED")]);
    expect(result.approvedCount).toBe(0);
    expect(result.underReviewCount).toBe(1);
  });

  it("never double-counts: at most one canonical thread per Assignment (first wins)", () => {
    const result = aggregateDownstream([assignment("a1", "p1", "ASSIGNED")], [thread("a1", "APPROVED"), thread("a1", "APPROVED"), thread("a1", "UNDER_REVIEW")]);
    expect(result.approvedCount).toBe(1);
    expect(result.underReviewCount).toBe(0);
  });

  it("does not depend on DRAFT/issued: a thread under any non-cancelled Assignment counts", () => {
    const result = aggregateDownstream([assignment("a1", "p1", "DRAFT")], [thread("a1", "UNDER_REVIEW")]);
    expect(result.underReviewCount).toBe(1);
  });
});

describe("computeCanCreateAssignment", () => {
  it("is true only for PLANNED/ACTIVE AND an actor holding assignments.create", () => {
    for (const status of CAMPAIGN_STATUSES) {
      const expected = status === "PLANNED" || status === "ACTIVE";
      expect(computeCanCreateAssignment(status, true)).toBe(expected);
    }
  });

  it("is always false without the create grant, whatever the lifecycle", () => {
    for (const status of CAMPAIGN_STATUSES) expect(computeCanCreateAssignment(status, false)).toBe(false);
  });
});
