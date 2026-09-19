import { randomUUID } from "node:crypto";

import type {
  EvidenceComplianceAssignment,
  EvidencePerformanceRecord,
  EvidenceProductionAssignment,
  EvidenceSnapshot,
  EvidenceThread,
  PartnerReviewSourceRef,
  PartnerReviewSourceType,
  PartnerReviewVersionDoc,
} from "./types";

// Step 13A.1: the ONE pure, actor-scoped source-context redaction.
//
// The stored snapshot, its sourceRefs and its source fingerprint are
// CANONICAL: Partner-scoped, complete and actor-independent (see
// evidence-collector.ts). Being allowed to read a Partner Review must NOT
// thereby grant visibility into the Campaign / Assignment / Content /
// Analytics records behind it - so the canonical evidence is never handed
// to a caller directly. Every actor-facing DTO is built from
// redactVersionForActor(), which:
//
//   - keeps every aggregate, count, presence figure, completeness flag,
//     incomplete reason, period and cutoff CANONICAL and identical for
//     every actor (nothing is re-summed or altered);
//   - for each evidence item, returns the currently approved safe source
//     context only for the source records the actor may access (the
//     accepted per-domain gates decide that - see source-access.ts) and
//     otherwise removes EVERY identifying field (raw refs, Campaign
//     name/ref, link URLs, provenance batch/sheet/row identifiers, matched
//     refs and account refs), keeping only the sanitized review evidence
//     (statuses, timestamps, counts, booleans, per-metric values, platform)
//     plus a neutral { sourceType, redacted: true } marker;
//   - replaces the removed identity by a per-response random `itemKey`,
//     shared by the Production and Compliance rows of the same Assignment
//     so a caller can still pair them. The key is NOT derived from the
//     real ref, is never persisted and is not comparable across responses
//     or actors.
//
// Nothing here ever writes or hashes anything: the stored doc and the
// fingerprint are untouched.

export type RedactedSourceType = "assignment" | "campaign" | "content" | "analytics";
export type RedactionMarker = { sourceType: RedactedSourceType; redacted: true };

export type WithheldSourceCounts = Record<PartnerReviewSourceType, number>;

// The refs (per source type) the acting user may access. Produced by
// source-access.ts from the accepted gates; a ref that is absent is
// treated as NOT accessible (fail closed).
export type SourceAccess = {
  assignments: ReadonlySet<string>;
  campaigns: ReadonlySet<string>;
  contents: ReadonlySet<string>;
  analyticsRecords: ReadonlySet<string>;
};

export const NO_SOURCE_ACCESS: SourceAccess = { assignments: new Set(), campaigns: new Set(), contents: new Set(), analyticsRecords: new Set() };

// --- Actor-facing (redacted) shapes ---------------------------------------------
// Deliberately NOT structurally compatible with the raw canonical shapes
// (each carries a required itemKey / redactedContext, and the snapshot a
// required snapshotView marker), so a raw EvidenceSnapshot can never be
// returned where an actor-facing one is expected - the compiler refuses.

export type ActorEvidenceThread = Omit<EvidenceThread, "contentRef" | "links"> & {
  contentRef: string | null;
  // null = withheld; linkCount / linkPlatforms stay as sanitized counts.
  links: EvidenceThread["links"] | null;
  redactedContext: RedactionMarker[];
};

export type ActorProductionAssignment = Omit<EvidenceProductionAssignment, "assignmentRef" | "campaignRef" | "campaignName" | "thread"> & {
  itemKey: string;
  assignmentRef: string | null;
  campaignRef: string | null;
  campaignName: string | null;
  thread: ActorEvidenceThread | null;
  redactedContext: RedactionMarker[];
};

export type ActorComplianceAssignment = Omit<EvidenceComplianceAssignment, "assignmentRef"> & {
  itemKey: string;
  assignmentRef: string | null;
  redactedContext: RedactionMarker[];
};

export type ActorPerformanceRecord = Omit<EvidencePerformanceRecord, "sourceRecordRef" | "matchedContentRef" | "matchedAssignmentRef" | "matchedCampaignRef" | "matchedPartnerAccountRef" | "postUrl" | "provenance"> & {
  itemKey: string;
  sourceRecordRef: string | null;
  matchedContentRef: string | null;
  matchedAssignmentRef: string | null;
  matchedCampaignRef: string | null;
  matchedPartnerAccountRef: string | null;
  postUrl: string | null;
  provenance: Omit<EvidencePerformanceRecord["provenance"], "batchRef" | "sheetName" | "sourceRowNumber"> & {
    batchRef: string | null;
    sheetName: string | null;
    sourceRowNumber: number | null;
  };
  redactedContext: RedactionMarker[];
};

export type ActorEvidenceSnapshot = Omit<EvidenceSnapshot, "production" | "compliance" | "performance" | "sourceRefs"> & {
  snapshotView: "actor_scoped";
  production: { assignments: ActorProductionAssignment[] };
  compliance: { assignments: ActorComplianceAssignment[] };
  performance: Omit<EvidenceSnapshot["performance"], "records"> & { records: ActorPerformanceRecord[] };
  // Only the refs this actor may access (see withheldSourceCounts for the rest).
  sourceRefs: PartnerReviewSourceRef[];
};

export type ActorVersionView = {
  snapshot: ActorEvidenceSnapshot;
  sourceRefs: PartnerReviewSourceRef[];
  withheldSourceCounts: WithheldSourceCounts;
};

// --- The refs a snapshot actually references --------------------------------------
export type SnapshotSourceRefs = { assignments: string[]; campaigns: string[]; contents: string[]; analyticsRecords: string[] };

// Distinct refs per source type, taken from the evidence items themselves
// (the same places the redaction reads them from).
export function collectSnapshotSourceRefs(snapshot: EvidenceSnapshot): SnapshotSourceRefs {
  const assignments = new Set<string>();
  const campaigns = new Set<string>();
  const contents = new Set<string>();
  const analyticsRecords = new Set<string>();
  for (const item of snapshot.production.assignments) {
    assignments.add(item.assignmentRef);
    campaigns.add(item.campaignRef);
    if (item.thread) contents.add(item.thread.contentRef);
  }
  for (const item of snapshot.compliance.assignments) assignments.add(item.assignmentRef);
  for (const record of snapshot.performance.records) analyticsRecords.add(record.sourceRecordRef);
  return { assignments: [...assignments], campaigns: [...campaigns], contents: [...contents], analyticsRecords: [...analyticsRecords] };
}

export function fullSourceAccessFor(snapshot: EvidenceSnapshot): SourceAccess {
  const refs = collectSnapshotSourceRefs(snapshot);
  return { assignments: new Set(refs.assignments), campaigns: new Set(refs.campaigns), contents: new Set(refs.contents), analyticsRecords: new Set(refs.analyticsRecords) };
}

// --- Redaction -------------------------------------------------------------------------
function marker(sourceType: RedactedSourceType): RedactionMarker {
  return { sourceType, redacted: true };
}

function redactThread(thread: EvidenceThread, contentAccessible: boolean): ActorEvidenceThread {
  if (contentAccessible) return { ...thread, redactedContext: [] };
  return {
    contentRef: null,
    status: thread.status,
    currentRevisionNumber: thread.currentRevisionNumber,
    openedAt: thread.openedAt,
    firstSubmittedAt: thread.firstSubmittedAt,
    lastSubmittedAt: thread.lastSubmittedAt,
    approvedAt: thread.approvedAt,
    cancelledAt: thread.cancelledAt,
    linkCount: thread.linkCount,
    linkPlatforms: [...thread.linkPlatforms],
    links: null,
    revisionRequestCount: thread.revisionRequestCount,
    revisionRequestCountIsExact: thread.revisionRequestCountIsExact,
    redactedContext: [marker("content")],
  };
}

function redactProduction(item: EvidenceProductionAssignment, itemKey: string, access: SourceAccess): ActorProductionAssignment {
  const assignmentAccessible = access.assignments.has(item.assignmentRef);
  // Campaign context printed on an Assignment row is Assignment-derived
  // linkage: it is shown only when the Assignment itself is accessible AND
  // the Campaign is accessible in its own right (each decided
  // independently - an accessible Assignment under an inaccessible
  // Campaign shows the Assignment but not the Campaign).
  const campaignAccessible = assignmentAccessible && access.campaigns.has(item.campaignRef);
  const contentAccessible = item.thread ? access.contents.has(item.thread.contentRef) : true;

  const redactedContext: RedactionMarker[] = [];
  if (!assignmentAccessible) redactedContext.push(marker("assignment"));
  if (!campaignAccessible) redactedContext.push(marker("campaign"));
  if (item.thread && !contentAccessible) redactedContext.push(marker("content"));

  return {
    itemKey,
    assignmentRef: assignmentAccessible ? item.assignmentRef : null,
    campaignRef: campaignAccessible ? item.campaignRef : null,
    campaignName: campaignAccessible ? item.campaignName : null,
    status: item.status,
    dueAt: item.dueAt,
    eventDate: item.eventDate,
    eventDateSource: item.eventDateSource,
    requiredCount: item.requiredCount,
    formats: [...item.formats],
    platforms: [...item.platforms],
    createdAt: item.createdAt,
    completed: item.completed,
    cancelled: item.cancelled,
    thread: item.thread ? redactThread(item.thread, contentAccessible) : null,
    redactedContext,
  };
}

function redactCompliance(item: EvidenceComplianceAssignment, itemKey: string, access: SourceAccess): ActorComplianceAssignment {
  const assignmentAccessible = access.assignments.has(item.assignmentRef);
  return { ...item, itemKey, assignmentRef: assignmentAccessible ? item.assignmentRef : null, redactedContext: assignmentAccessible ? [] : [marker("assignment")] };
}

function redactPerformance(record: EvidencePerformanceRecord, itemKey: string, access: SourceAccess): ActorPerformanceRecord {
  if (access.analyticsRecords.has(record.sourceRecordRef)) return { ...record, itemKey, redactedContext: [] };
  return {
    itemKey,
    sourceRecordRef: null,
    platform: record.platform,
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerAccountRef: null,
    postUrl: null,
    postDateTime: record.postDateTime,
    reportingPeriod: { ...record.reportingPeriod },
    provenance: {
      batchRef: null,
      sheetName: null,
      sourceRowNumber: null,
      correctionRevision: record.provenance.correctionRevision,
      matchState: record.provenance.matchState,
      matchEvidenceTier: record.provenance.matchEvidenceTier,
      matchReasonCode: record.provenance.matchReasonCode,
      importedAt: record.provenance.importedAt,
    },
    metrics: { ...record.metrics },
    redactedContext: [marker("analytics")],
  };
}

function compareRefs(a: PartnerReviewSourceRef, b: PartnerReviewSourceRef): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

export function redactVersionForActor(
  version: Pick<PartnerReviewVersionDoc, "snapshot" | "sourceRefs">,
  access: SourceAccess,
  options: { newItemKey?: () => string } = {},
): ActorVersionView {
  const newItemKey = options.newItemKey ?? (() => randomUUID());
  const { snapshot } = version;

  // One key per Assignment, shared by its Production and Compliance rows.
  const keyByAssignmentRef = new Map<string, string>();
  const keyForAssignment = (assignmentRef: string): string => {
    let key = keyByAssignmentRef.get(assignmentRef);
    if (!key) {
      key = newItemKey();
      keyByAssignmentRef.set(assignmentRef, key);
    }
    return key;
  };

  const production = snapshot.production.assignments.map((item) => redactProduction(item, keyForAssignment(item.assignmentRef), access));
  const compliance = snapshot.compliance.assignments.map((item) => redactCompliance(item, keyForAssignment(item.assignmentRef), access));
  const records = snapshot.performance.records.map((record) => redactPerformance(record, newItemKey(), access));

  // The actor-facing ref list is DERIVED FROM what survived redaction, so it
  // can never name a source the response itself withholds.
  const shown = new Map<string, PartnerReviewSourceRef>();
  const show = (type: PartnerReviewSourceType, ref: string | null) => {
    if (ref !== null) shown.set(`${type} ${ref}`, { type, ref });
  };
  for (const item of production) {
    show("assignment", item.assignmentRef);
    show("campaign", item.campaignRef);
    show("content", item.thread?.contentRef ?? null);
  }
  for (const item of compliance) show("assignment", item.assignmentRef);
  for (const record of records) show("analyticsSourceRecord", record.sourceRecordRef);
  const sourceRefs = [...shown.values()].sort(compareRefs);

  const withheldSourceCounts: WithheldSourceCounts = { assignment: 0, content: 0, analyticsSourceRecord: 0, campaign: 0 };
  // Withheld = canonical distinct refs of that type that did not survive.
  for (const entry of version.sourceRefs) {
    if (!shown.has(`${entry.type} ${entry.ref}`)) withheldSourceCounts[entry.type] += 1;
  }

  return {
    snapshot: {
      snapshotView: "actor_scoped",
      schemaVersion: snapshot.schemaVersion,
      partnerRef: snapshot.partnerRef,
      periodKey: snapshot.periodKey,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      evidenceCutoff: snapshot.evidenceCutoff,
      production: { assignments: production },
      compliance: { assignments: compliance },
      // Aggregates below are canonical and identical for every actor.
      performance: {
        records,
        metricPresence: snapshot.performance.metricPresence.map((entry) => ({ ...entry })),
        unavailableMetrics: [...snapshot.performance.unavailableMetrics],
        latestImportedAt: snapshot.performance.latestImportedAt,
      },
      completeness: {
        truncated: { ...snapshot.completeness.truncated },
        counts: { ...snapshot.completeness.counts },
        incompleteReasons: [...snapshot.completeness.incompleteReasons],
      },
      sourceRefs,
    },
    sourceRefs,
    withheldSourceCounts,
  };
}
