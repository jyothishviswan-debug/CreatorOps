import { FieldPath } from "firebase-admin/firestore";

import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection } from "@/server/analytics/firestore";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema } from "@/server/analytics/types";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { assignmentDocSchema } from "@/server/assignments/types";
import { contentCollection } from "@/server/content/firestore";
import { contentDocSchema } from "@/server/content/types";

import type { ChannelSnapshotRecordSource } from "./commercial-builder";
import { getGoverningCommercialPolicyResolution, policyNeedsChannelSnapshots } from "./commercial-policy";
import { buildEvidence, selectInPeriodAssignments, type AnalyticsRecordSource, type AssignmentSource, type BuiltEvidence, type ContentThreadSource } from "./evidence-builder";
import type { ReviewPeriod } from "./period";

// Step 13A: the ONE I/O evidence collector. It reads upstream Assignments,
// Content and Analytics records for ONE Partner and hands them to the pure
// builder (evidence-builder.ts).
//
// AUTHORITY DECISION (deterministic interpretation of "authorized upstream
// evidence"): evidence is collected under the PARTNER-SCOPE authority,
// NOT filtered by the acting user's own Campaign/Assignment/Content scope.
// Authorization to act on a review is the Partner's Record Scope (checked
// by the caller via requirePartnerInScope before this runs). If the
// snapshot depended on who asked, two actors would produce different
// snapshots and fingerprints and freshness would be meaningless. The
// snapshot only ever exposes safe structured fields (refs, statuses,
// timestamps, counts, public post links, numeric metrics) - never raw
// Analytics row payloads or contact/identity data.
//
// Step 13A.1 (revised): the governing commercial policy for the Partner +
// period is fetched here too, through the ONE seam in commercial-policy.ts
// (default: none - the Agreement module is not built), so it is exactly as
// actor-independent as the rest of the evidence and can never come from a
// client payload. Channel snapshot records (Analytics channel_account rows)
// are read ONLY when that policy names a followerGrowth target, so the
// no-policy path costs nothing extra.
//
// Every read is bounded: paged by document id with a hard scan ceiling, an
// explicit truncation flag when the ceiling is reached, and one chunked
// bulk read (never one read per row) for Content threads. All queries are
// equality-only, so they need no composite index.

export const COLLECTOR_PAGE_SIZE = 200;
// Hard scan ceilings per Partner. Reaching one with more documents still
// remaining sets the matching truncation flag (and an incomplete reason).
export const MAX_ASSIGNMENTS_SCANNED = 1000;
export const MAX_ANALYTICS_RECORDS_SCANNED = 2000;
export const MAX_CHANNEL_RECORDS_SCANNED = 1000;
// Firestore's `in` operator caps at 30 values per query.
const IN_QUERY_CHUNK = 30;

async function scanByEquality<T>(
  collection: FirebaseFirestore.CollectionReference,
  field: string,
  value: string,
  parse: (data: FirebaseFirestore.DocumentData) => T | null,
  ceiling: number,
): Promise<{ items: T[]; scanned: number; truncated: boolean }> {
  const items: T[] = [];
  let scanned = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    // Read at most ceiling + 1 documents in total: the extra one only
    // proves that more remain beyond the ceiling.
    const remaining = ceiling + 1 - scanned;
    if (remaining <= 0) break;

    let query = collection.where(field, "==", value).orderBy(FieldPath.documentId()).limit(Math.min(COLLECTOR_PAGE_SIZE, remaining));
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    if (snapshot.empty) return { items, scanned, truncated: false };

    for (const doc of snapshot.docs) {
      if (scanned >= ceiling) return { items, scanned, truncated: true };
      scanned += 1;
      const parsed = parse(doc.data());
      if (parsed !== null) items.push(parsed);
    }

    last = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < Math.min(COLLECTOR_PAGE_SIZE, remaining)) return { items, scanned, truncated: false };
  }

  return { items, scanned, truncated: true };
}

export async function collectPartnerEvidence(partnerRef: string, period: ReviewPeriod, options: { now?: () => Date } = {}): Promise<BuiltEvidence> {
  // Step 14C: a policy, nothing, or a NEUTRAL overlap conflict (never picked, never merged, never thrown).
  const resolution = await getGoverningCommercialPolicyResolution(partnerRef, period.periodKey);
  const policy = resolution.kind === "policy" ? resolution.policy : null;
  const policyConflict = resolution.kind === "conflict" ? { reason: "multiple_applicable_agreements" as const, agreementRefs: resolution.agreementRefs } : null;

  const [assignmentScan, analyticsScan, channelScan] = await Promise.all([
    scanByEquality<AssignmentSource>(
      assignmentsCollection(),
      "partnerRef",
      partnerRef,
      (data) => {
        const parsed = assignmentDocSchema.safeParse(data);
        return parsed.success ? parsed.data : null;
      },
      MAX_ASSIGNMENTS_SCANNED,
    ),
    scanByEquality<AnalyticsRecordSource>(
      analyticsContentSourceRecordsCollection(),
      "matchedPartnerRef",
      partnerRef,
      (data) => {
        const parsed = analyticsContentSourceRecordDocSchema.safeParse(data);
        return parsed.success ? parsed.data : null;
      },
      MAX_ANALYTICS_RECORDS_SCANNED,
    ),
    policyNeedsChannelSnapshots(policy)
      ? scanByEquality<ChannelSnapshotRecordSource>(
          analyticsChannelSourceRecordsCollection(),
          "matchedPartnerRef",
          partnerRef,
          (data) => {
            const parsed = analyticsChannelSourceRecordDocSchema.safeParse(data);
            return parsed.success ? parsed.data : null;
          },
          MAX_CHANNEL_RECORDS_SCANNED,
        )
      : Promise.resolve({ items: [] as ChannelSnapshotRecordSource[], scanned: 0, truncated: false }),
  ]);

  // ONE bulk, chunked read of the canonical Content threads for the
  // in-period Assignments only (one canonical thread per Assignment) -
  // never one lookup per Assignment.
  const inPeriodRefs = selectInPeriodAssignments(assignmentScan.items, period).selected.map((entry) => entry.assignment.assignmentRef);
  const chunks: string[][] = [];
  for (let i = 0; i < inPeriodRefs.length; i += IN_QUERY_CHUNK) chunks.push(inPeriodRefs.slice(i, i + IN_QUERY_CHUNK));

  const threadSnapshots = await Promise.all(chunks.map((chunk) => contentCollection().where("assignmentRef", "in", chunk).limit(chunk.length * 2).get()));
  const threads: ContentThreadSource[] = [];
  for (const snapshot of threadSnapshots) {
    for (const doc of snapshot.docs) {
      const parsed = contentDocSchema.safeParse(doc.data());
      // A thread must belong to this Partner as well - defense in depth.
      if (parsed.success && parsed.data.partnerRef === partnerRef) threads.push(parsed.data);
    }
  }

  const now = options.now ? options.now() : new Date();

  return buildEvidence({
    partnerRef,
    period,
    evidenceCutoff: now.toISOString(),
    assignments: assignmentScan.items,
    assignmentScanTruncated: assignmentScan.truncated,
    assignmentsScanned: assignmentScan.scanned,
    threads,
    analyticsRecords: analyticsScan.items,
    analyticsScanTruncated: analyticsScan.truncated,
    analyticsRecordsScanned: analyticsScan.scanned,
    commercialPolicy: policy,
    commercialPolicyConflict: policyConflict,
    channelRecords: channelScan.items,
    channelScanTruncated: channelScan.truncated,
  });
}
