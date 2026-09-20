import type { AssignmentDoc } from "@/server/assignments/types";

import { derivePeriod, isFuturePeriod, reviewRefFor, toUtcDate } from "./period";

// Step 13B: the PURE part of Needs Review candidate discovery. A candidate is a
// Partner-month with in-period evidence but NO review head yet. Membership uses
// the accepted period rule (the Assignment's dueAt when it parses, else its
// createdAt - see evidence-builder.ts's resolveAssignmentEventDate). The rule is
// restated here in four lines ON PURPOSE: importing it would pull the evidence
// builder (and through it the fingerprint / freshness evaluator) into the list
// path, which the module boundary forbids. A unit test pins this copy to the
// accepted function across a matrix, so the two can never drift. Nothing here
// reads anything: the I/O (a bounded scoped scan of Assignments, the head
// existence check, the live Partner scope filter) lives in review-scan.ts.

export type CandidateGroup = { partnerRef: string; periodKey: string; reviewRef: string; assignments: number };

type GroupableAssignment = Pick<AssignmentDoc, "partnerRef" | "createdAt"> & { brief: Pick<AssignmentDoc["brief"], "dueAt"> };

// The Assignment's authoritative event date: a parseable dueAt, else its createdAt; null when neither can be placed.
export function assignmentEventDate(assignment: Pick<GroupableAssignment, "createdAt"> & { brief: { dueAt: string | null } }): string | null {
  if (assignment.brief.dueAt) {
    const fromDue = toUtcDate(assignment.brief.dueAt);
    if (fromDue) return fromDue;
  }
  return toUtcDate(assignment.createdAt);
}

// One group per (partnerRef, month). An Assignment whose event date cannot be
// placed (no parseable dueAt or createdAt) is not part of any month - exactly as
// the evidence builder treats it. A month that has NOT STARTED yet is never a
// candidate: the accepted backend refuses to generate a review for it
// (isFuturePeriod - the current month is allowed), so offering it as "Needs
// review" would show a row nobody can act on and would let a future month become
// the default. The SAME isFuturePeriod rule the generate route enforces is used
// here, so the two can never drift.
export function groupAssignmentsByPartnerMonth(assignments: readonly GroupableAssignment[], now: Date = new Date()): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const assignment of assignments) {
    const eventDate = assignmentEventDate(assignment);
    if (!eventDate) continue;
    const periodKey = eventDate.slice(0, 7);
    const period = derivePeriod(periodKey);
    if (!period || isFuturePeriod(period, now)) continue;
    const key = `${assignment.partnerRef}|${periodKey}`;
    const existing = groups.get(key);
    if (existing) existing.assignments += 1;
    else groups.set(key, { partnerRef: assignment.partnerRef, periodKey, reviewRef: reviewRefFor(assignment.partnerRef, periodKey), assignments: 1 });
  }
  return [...groups.values()];
}

// Candidates = groups that do not already have a head. `existingReviewRefs` is
// the set of reviewRefs (deterministic per Partner + month) that exist.
export function excludeExistingReviews(groups: readonly CandidateGroup[], existingReviewRefs: ReadonlySet<string>): CandidateGroup[] {
  return groups.filter((group) => !existingReviewRefs.has(group.reviewRef));
}

// Deterministic order: newest month first, then Partner display name, then partnerRef.
export function compareCandidates(a: { periodKey: string; partnerRef: string; name: string }, b: { periodKey: string; partnerRef: string; name: string }): number {
  if (a.periodKey !== b.periodKey) return a.periodKey < b.periodKey ? 1 : -1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.partnerRef < b.partnerRef ? -1 : a.partnerRef > b.partnerRef ? 1 : 0;
}
