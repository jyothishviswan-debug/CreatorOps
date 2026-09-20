import { neutralCommercialEvidence } from "./commercial-neutral";
import {
  headDisplaySchema,
  reviewListSummarySchema,
  type EvidenceComplianceAssignment,
  type EvidenceLfcSfc,
  type EvidenceMonthlyDeliverable,
  type HeadDisplay,
  type PartnerReviewEventKind,
  type PartnerReviewHeadDoc,
  type PartnerReviewStatus,
  type PartnerReviewVersionDoc,
  type ReviewListSummary,
} from "./types";

// Step 13B: the ONE pure derivation of the compact list summary from a stored
// canonical snapshot, plus the head-level display block built from it.
//
// Pure: no I/O, no clock, no actor. It reuses the accepted snapshot fields and
// only COUNTS / copies them - it never re-derives business truth from raw
// evidence, never computes money and never produces a score, rating or rank.
// Everything here is a PROJECTION FOR LISTS: the canonical snapshot stays the
// evidence of record, and nothing in this file is an authorization input.

// Content thread statuses this projection counts (canonical Content lifecycle).
const UNDER_REVIEW = "UNDER_REVIEW";
const APPROVED = "APPROVED";

function sumReported(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let any = false;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      any = true;
    }
  }
  // Nothing reported => null (unavailable), never zero.
  return any ? total : null;
}

// The structural subset of a snapshot the summary READS. Both the canonical stored EvidenceSnapshot and
// the actor-scoped (redacted) view satisfy it - redaction keeps every status, boolean, timestamp and
// metric value this counts, so the summary of the two is identical (the Review Detail derives its
// independent summaries from the actor view with this very function; nothing is re-derived in React).
export type SummarySnapshot = {
  production: { assignments: ReadonlyArray<{ completed: boolean; cancelled: boolean; thread: { status: string } | null }> };
  compliance: { assignments: ReadonlyArray<Pick<EvidenceComplianceAssignment, "submittedAt" | "submittedBeforeDue" | "revisionRequestCount" | "hasNoThread" | "threadOpenWithNoLinks" | "notCompletedPastDue">> };
  performance: { records: ReadonlyArray<{ platform: string; matchedPartnerAccountRef: string | null; metrics: Record<string, number | null> }> };
  commercial?: {
    governingAgreement: { agreementRef: string; agreementVersion: number } | null;
    monthlyDeliverable: Pick<EvidenceMonthlyDeliverable, "requiredCount" | "actualQualifyingCount" | "variance" | "evaluation" | "affectsPayment">;
    lfcSfc: Pick<EvidenceLfcSfc, "status" | "lfcCount" | "sfcCount" | "unclassifiedCount" | "affectsPayment">;
    targets: ReadonlyArray<{ evaluation: "met" | "not_met" | "unavailable" }>;
  };
  completeness: { incompleteReasons: readonly string[]; truncated: Record<string, boolean> };
};

export function computeReviewListSummary(snapshot: SummarySnapshot): ReviewListSummary {
  const production = snapshot.production.assignments;
  const compliance = snapshot.compliance.assignments;
  const records = snapshot.performance.records;
  // A version stored before commercial evidence existed has no `commercial` key: it reads as the neutral all-unavailable shape.
  const commercial = snapshot.commercial ?? neutralCommercialEvidence();

  // --- Compliance: plain counts of the stored booleans -------------------------
  let onTime = 0;
  let late = 0;
  let unknownTiming = 0;
  let revisionRequests = 0;
  let missingOrIncompleteWork = 0;
  for (const item of compliance) {
    if (item.submittedAt !== null) {
      if (item.submittedBeforeDue === true) onTime += 1;
      else if (item.submittedBeforeDue === false) late += 1;
      else unknownTiming += 1;
    }
    revisionRequests += item.revisionRequestCount;
    if (item.hasNoThread || item.threadOpenWithNoLinks || item.notCompletedPastDue) missingOrIncompleteWork += 1;
  }

  // --- Performance: native per-platform sums; a metric no record reported is null ---
  const byPlatform = new Map<string, Array<(typeof records)[number]>>();
  for (const record of records) {
    const list = byPlatform.get(record.platform) ?? [];
    list.push(record);
    byPlatform.set(record.platform, list);
  }
  const perPlatform: ReviewListSummary["performance"]["perPlatform"] = {};
  for (const platform of [...byPlatform.keys()].sort()) {
    const list = byPlatform.get(platform)!;
    perPlatform[platform] = {
      views: sumReported(list.map((record) => record.metrics.views)),
      engagement: sumReported(list.map((record) => record.metrics.engagement)),
      likes: sumReported(list.map((record) => record.metrics.likes)),
      comments: sumReported(list.map((record) => record.metrics.comments)),
    };
  }
  const followerRecords = records.filter((record) => typeof record.metrics.profileFollowers === "number");
  const followerAccounts = new Set(followerRecords.map((record) => record.matchedPartnerAccountRef).filter((ref): ref is string => ref !== null));

  const targets = commercial.targets;

  return reviewListSummarySchema.parse({
    production: {
      assignmentsIncluded: production.length,
      completedAssignments: production.filter((item) => item.completed).length,
      underReviewContent: production.filter((item) => item.thread?.status === UNDER_REVIEW).length,
      approvedContent: production.filter((item) => item.thread?.status === APPROVED).length,
      cancelledFlagged: production.filter((item) => item.cancelled).length,
    },
    commercial: {
      governing: commercial.governingAgreement ? { ref: commercial.governingAgreement.agreementRef, version: commercial.governingAgreement.agreementVersion } : null,
      deliverable: {
        required: commercial.monthlyDeliverable.requiredCount,
        actual: commercial.monthlyDeliverable.actualQualifyingCount,
        variance: commercial.monthlyDeliverable.variance,
        evaluation: commercial.monthlyDeliverable.evaluation,
        affectsPayment: commercial.monthlyDeliverable.affectsPayment,
      },
      lfcSfc: {
        status: commercial.lfcSfc.status,
        lfc: commercial.lfcSfc.lfcCount,
        sfc: commercial.lfcSfc.sfcCount,
        unclassified: commercial.lfcSfc.unclassifiedCount,
        affectsPayment: commercial.lfcSfc.affectsPayment,
      },
      targets: {
        total: targets.length,
        met: targets.filter((target) => target.evaluation === "met").length,
        notMet: targets.filter((target) => target.evaluation === "not_met").length,
        unavailable: targets.filter((target) => target.evaluation === "unavailable").length,
        affectsPayment: false,
      },
    },
    compliance: { onTime, late, unknownTiming, revisionRequests, missingOrIncompleteWork },
    performance: {
      state: records.length > 0 ? "available" : "missing",
      recordCount: records.length,
      perPlatform,
      followerSnapshotRecords: followerRecords.length,
      followerSnapshotAccounts: followerAccounts.size,
    },
    completeness: {
      incompleteReasonCount: snapshot.completeness.incompleteReasons.length,
      truncated: Object.values(snapshot.completeness.truncated).some(Boolean),
    },
  });
}

// The stored summary when the version has one, else derived from its stored
// snapshot (a version written before Step 13B). Never needs any upstream read.
export function summaryOfVersion(version: Pick<PartnerReviewVersionDoc, "summary" | "snapshot">): ReviewListSummary {
  return version.summary ?? computeReviewListSummary(version.snapshot);
}

export type HeadDisplayInput = {
  version: Pick<PartnerReviewVersionDoc, "version" | "status" | "evidenceCutoff" | "summary" | "snapshot">;
  latestVersion: number;
  event: { kind: PartnerReviewEventKind; at: string };
  // The head's current finalized version after this change (null when none).
  finalized: { version: number; at: string | null } | null;
  supersededVersion?: number | null;
};

// Builds the head's display block. Called inside the SAME transaction that
// changes the head, so the projection can never drift from the head it mirrors.
export function buildHeadDisplay(input: HeadDisplayInput): HeadDisplay {
  return headDisplaySchema.parse({
    version: input.version.version,
    status: input.version.status satisfies PartnerReviewStatus,
    summary: summaryOfVersion(input.version),
    evidenceCutoff: input.version.evidenceCutoff,
    lastEventKind: input.event.kind,
    lastEventAt: input.event.at,
    revisionCount: Math.max(0, input.latestVersion - 1),
    supersededVersion: input.supersededVersion ?? null,
    finalizedVersion: input.finalized?.version ?? null,
    finalizedAt: input.finalized?.at ?? null,
  });
}

// The finalized version's time carried forward when only a non-finalizing
// change happens (submit / refresh / revision keep whatever was recorded).
export function carriedFinalized(head: Pick<PartnerReviewHeadDoc, "currentFinalizedVersion" | "display">, fallbackAt: string | null = null): { version: number; at: string | null } | null {
  if (head.currentFinalizedVersion === null) return null;
  return { version: head.currentFinalizedVersion, at: head.display?.finalizedVersion === head.currentFinalizedVersion ? head.display.finalizedAt : fallbackAt };
}
