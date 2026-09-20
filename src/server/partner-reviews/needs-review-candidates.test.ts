import { describe, expect, it } from "vitest";

import { resolveAssignmentEventDate } from "./evidence-builder";
import { assignmentEventDate, compareCandidates, excludeExistingReviews, groupAssignmentsByPartnerMonth } from "./needs-review-candidates";
import { reviewRefFor } from "./period";

const a = (partnerRef: string, dueAt: string | null, createdAt = "2026-01-05T08:00:00.000Z") => ({ partnerRef, createdAt, brief: { dueAt } });

describe("needs-review candidate grouping (the accepted dueAt-else-createdAt month rule)", () => {
  it("groups Assignments by (Partner, month) using dueAt, else createdAt", () => {
    const groups = groupAssignmentsByPartnerMonth([a("p1", "2026-03-10"), a("p1", "2026-03-30"), a("p1", null, "2026-04-02T00:00:00.000Z"), a("p2", "2026-03-11"), a("p1", "2026-05-15", "2026-03-01T00:00:00.000Z")]);
    const byKey = Object.fromEntries(groups.map((g) => [`${g.partnerRef}|${g.periodKey}`, g.assignments]));
    expect(byKey).toEqual({ "p1|2026-03": 2, "p1|2026-04": 1, "p2|2026-03": 1, "p1|2026-05": 1 });
  });

  it("a month that has not started yet is never a candidate (the generate route refuses it); the current month and earlier months are", () => {
    const assignments = [a("p1", "2026-08-31"), a("p1", "2026-09-01"), a("p1", "2026-09-30"), a("p1", "2026-10-01"), a("p2", "2027-01-15"), a("p2", null, "2026-12-05T00:00:00.000Z")];
    const keys = (now: string) =>
      groupAssignmentsByPartnerMonth(assignments, new Date(now))
        .map((g) => `${g.partnerRef}|${g.periodKey}`)
        .sort();
    // Today is mid-September 2026: September is the CURRENT month (allowed); October onward has not started.
    expect(keys("2026-09-20T12:00:00.000Z")).toEqual(["p1|2026-08", "p1|2026-09"]);
    // Exactly on the last instant of September, October still has not started...
    expect(keys("2026-09-30T23:59:59.999Z")).toEqual(["p1|2026-08", "p1|2026-09"]);
    // ...and on the first day of October it has (the boundary is the UTC calendar month, like isFuturePeriod).
    expect(keys("2026-10-01T00:00:00.000Z")).toEqual(["p1|2026-08", "p1|2026-09", "p1|2026-10"]);
    // The same rule the generate route enforces: nothing here is a month generation would refuse.
    for (const group of groupAssignmentsByPartnerMonth(assignments, new Date("2026-09-20T12:00:00.000Z"))) {
      expect(group.periodKey <= "2026-09").toBe(true);
    }
  });

  it("an unparseable dueAt falls back to createdAt; an Assignment that cannot be placed joins no month", () => {
    const groups = groupAssignmentsByPartnerMonth([a("p1", "soon", "2026-02-03T00:00:00.000Z"), a("p1", null, "garbage")]);
    expect(groups.map((g) => `${g.partnerRef}|${g.periodKey}`)).toEqual(["p1|2026-02"]);
  });

  it("each group carries the deterministic reviewRef of its Partner-month", () => {
    const [group] = groupAssignmentsByPartnerMonth([a("p1", "2026-03-10")]);
    expect(group!.reviewRef).toBe(reviewRefFor("p1", "2026-03"));
  });

  it("a Partner-month that already has a review head is excluded", () => {
    const groups = groupAssignmentsByPartnerMonth([a("p1", "2026-03-10"), a("p2", "2026-03-10"), a("p1", "2026-04-10")]);
    const remaining = excludeExistingReviews(groups, new Set([reviewRefFor("p1", "2026-03")]));
    expect(remaining.map((g) => `${g.partnerRef}|${g.periodKey}`).sort()).toEqual(["p1|2026-04", "p2|2026-03"]);
  });

  it("orders newest month first, then Partner name, then partnerRef (deterministic)", () => {
    const rows = [
      { periodKey: "2026-02", partnerRef: "p1", name: "zed" },
      { periodKey: "2026-03", partnerRef: "p9", name: "bob" },
      { periodKey: "2026-03", partnerRef: "p3", name: "amy" },
      { periodKey: "2026-03", partnerRef: "p2", name: "amy" },
    ];
    const sorted = [...rows].sort(compareCandidates).map((r) => r.partnerRef);
    expect(sorted).toEqual(["p2", "p3", "p9", "p1"]);
    expect([...rows].reverse().sort(compareCandidates).map((r) => r.partnerRef)).toEqual(sorted);
  });
});

describe("the restated period rule can never drift from the accepted one", () => {
  it("assignmentEventDate equals evidence-builder's resolveAssignmentEventDate over a matrix", () => {
    const dues = [null, "2026-03-10", "2026-03-31T23:59:59.999Z", "2026-04-01T00:00:00.000Z", "soon", "2026-13-40", "2019-02-29", ""];
    const created = ["2026-01-10T08:00:00.000Z", "2026-03-04T09:00:00.000Z", "garbage", "2026-02-30T00:00:00.000Z"];
    for (const dueAt of dues) {
      for (const createdAt of created) {
        const assignment = { createdAt, brief: { dueAt } };
        expect(assignmentEventDate(assignment), `${dueAt} / ${createdAt}`).toBe(resolveAssignmentEventDate(assignment)?.eventDate ?? null);
      }
    }
  });
});
