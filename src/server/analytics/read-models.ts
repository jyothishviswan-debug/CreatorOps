import { isUsingEmulators } from "@/lib/env/server";
import type { ActorContext } from "@/server/authz/types";

import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsReadModelSnapshotsCollection } from "./firestore";
import { ANALYTICS_METRIC_REGISTRY, type AnalyticsMetricId } from "./metric-registry";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema, analyticsReadModelSnapshotDocSchema, type AnalyticsChannelSourceRecordDoc, type AnalyticsContentSourceRecordDoc, type AnalyticsReadModelSnapshotDoc, type AnalyticsServiceResult } from "./types";

// Step 12A section 14: read-model architecture. Two, deliberately
// different, mechanisms:
//
// 1. Pure, scope-agnostic aggregation FUNCTIONS below - they take an
//    ALREADY scope-constrained, bounded set of source records (fetched
//    by the caller via the same scoped-list.ts branch-planner pattern
//    every other domain uses - see explorer-service.ts) and compute the
//    aggregate live, at query time. This is what an ordinary scoped read
//    uses - a Manager can never see a Head's or a cross-scope actor's
//    totals baked into any shared cache, because there IS no cache on
//    this path; every call recomputes from whatever the caller already
//    proved it may see.
//
// 2. rebuildAnalyticsReadModels() below - the ONE separately-marked,
//    persisted "rebuild" snapshot (analyticsReadModelSnapshots/{uid}),
//    explicitly GLOBAL/unscoped, computed only via this internal/admin/
//    test-invoked function (gated Super-Admin-only when called with a
//    real actor, or emulator-only when called with no actor at all - a
//    test-harness invocation - never exposed as an ordinary authenticated
//    API route). Every field of analyticsReadModelSnapshotDocSchema is
//    commented, in types.ts, as "rebuildable, may be stale, global-scope-
//    only, never trusted for a scoped read" - nothing in
//    explorer-service.ts or campaign-readiness.ts ever reads FROM this
//    snapshot; it exists purely as an inspectable, deterministic
//    global rollup, e.g. for an eventual ops dashboard that explicitly
//    wants a whole-org number rather than one actor's own scoped view.

type SupportedContentAggregateMetric = Extract<AnalyticsMetricId, "comments" | "likes" | "views" | "profileFollowers" | "engagement">;
const SUPPORTED_CONTENT_METRICS: SupportedContentAggregateMetric[] = ["comments", "likes", "views", "profileFollowers", "engagement"];

export function aggregatePlatformTotals(records: AnalyticsContentSourceRecordDoc[]): Record<string, Record<string, number | null>> {
  const totals: Record<string, Record<string, number | null>> = {};
  const seenAny: Record<string, Record<string, boolean>> = {};

  for (const record of records) {
    totals[record.platform] ??= {};
    seenAny[record.platform] ??= {};
    for (const metric of SUPPORTED_CONTENT_METRICS) {
      const value = record[metric];
      if (value === null) continue;
      totals[record.platform]![metric] = (totals[record.platform]![metric] ?? 0) + value;
      seenAny[record.platform]![metric] = true;
    }
  }

  // A metric never once reported for a platform stays `null` (never `0`)
  // - "missing" and "reported as zero" must never be confused, same
  // discipline as parseSupportedMetric itself.
  for (const platform of Object.keys(totals)) {
    for (const metric of SUPPORTED_CONTENT_METRICS) {
      if (!seenAny[platform]?.[metric]) totals[platform]![metric] = null;
    }
  }

  return totals;
}

export function aggregateSourceRecordCountsByPlatform(records: Array<{ platform: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.platform] = (counts[record.platform] ?? 0) + 1;
  return counts;
}

// Interactions - the sum of only explicitly source-reported COMPATIBLE
// metrics (comments + likes), NEVER a blended/weighted score, and NEVER
// including Shares (an unsupported metric - see metric-registry.ts). A
// row contributes to a platform's total only when BOTH comments AND
// likes were themselves source-reported on that row - a row missing
// either one contributes nothing (never treated as zero), so the total
// never understates by silently treating "not reported" as "reported as
// zero" for one side of the sum.
export function aggregateInteractionsByPlatform(records: AnalyticsContentSourceRecordDoc[]): Record<string, number | null> {
  const totals: Record<string, number> = {};
  const seenAny: Record<string, boolean> = {};

  for (const record of records) {
    if (record.comments === null || record.likes === null) continue;
    totals[record.platform] = (totals[record.platform] ?? 0) + record.comments + record.likes;
    seenAny[record.platform] = true;
  }

  const result: Record<string, number | null> = {};
  const platforms = new Set([...records.map((r) => r.platform)]);
  for (const platform of platforms) result[platform] = seenAny[platform] ? totals[platform]! : null;
  return result;
}

export type PartnerRankingEntry = { partnerRef: string; total: number };

// Ranks Partners by exactly ONE selected supported metric at a time -
// never a blended score. Only MATCHED records (a matchedPartnerRef must
// be present) contribute; a Partner with zero non-null values for the
// selected metric across every one of their matched records is simply
// absent from the ranking (never shown with a fabricated 0).
export function rankPartnersByMetric(records: AnalyticsContentSourceRecordDoc[], metric: Extract<AnalyticsMetricId, "comments" | "likes" | "views" | "profileFollowers" | "engagement">): PartnerRankingEntry[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    if (!record.matchedPartnerRef) continue;
    const value = record[metric];
    if (value === null) continue;
    totals.set(record.matchedPartnerRef, (totals.get(record.matchedPartnerRef) ?? 0) + value);
  }
  return [...totals.entries()].map(([partnerRef, total]) => ({ partnerRef, total })).sort((a, b) => b.total - a.total);
}

export type IngestionExceptionCounts = { unmatched: number; ambiguous: number };

export function aggregateIngestionExceptionCounts(records: Array<{ matchState: string }>): IngestionExceptionCounts {
  return {
    unmatched: records.filter((r) => r.matchState === "UNMATCHED").length,
    ambiguous: records.filter((r) => r.matchState === "AMBIGUOUS").length,
  };
}

// Data freshness by platform - the most recent record's own createdAt
// (set at commit time, i.e. the moment its owning batch actually wrote
// it) among the caller's already scope-constrained set. A deliberately
// honest simplification of "most recent batch's completedAt per
// platform" (Section 14's own wording) - a batch's own header carries no
// platform of its own (one batch/file can span multiple platform
// sheets), so per-record createdAt is the accurate, platform-precise
// substitute, and is never later than its own batch's completedAt.
export function aggregateFreshnessByPlatform(records: Array<{ platform: string; createdAt: string }>): Record<string, string | null> {
  const freshest: Record<string, string> = {};
  for (const record of records) {
    if (!freshest[record.platform] || record.createdAt > freshest[record.platform]!) freshest[record.platform] = record.createdAt;
  }
  const result: Record<string, string | null> = {};
  for (const platform of Object.keys(freshest)) result[platform] = freshest[platform] ?? null;
  return result;
}

// ---- Rebuildable global snapshot (Section 14/22) -------------------------

const GLOBAL_SNAPSHOT_UID = "global";
const REBUILD_SCAN_LIMIT = 5000; // same order of magnitude as MAX_IMPORT_ROWS_PER_BATCH - a real, documented bound, never an unbounded scan.

export async function rebuildAnalyticsReadModels(actor: ActorContext | null): Promise<AnalyticsServiceResult<AnalyticsReadModelSnapshotDoc>> {
  // Gate: Super-Admin-only when a real actor is supplied, or
  // emulator-only when invoked with no actor at all (the test-harness
  // invocation path) - never a public, unauthenticated route.
  if (actor) {
    if (actor.role !== "super_admin") return { ok: false, code: "unauthorized", message: "Only Super Admin may rebuild Analytics read models.", reason: "action_denied" };
  } else if (!isUsingEmulators()) {
    return { ok: false, code: "unauthorized", message: "rebuildAnalyticsReadModels: refusing to run without an actor outside the emulator (test-harness-only path).", reason: "not_authenticated" };
  }

  const contentSnapshot = await analyticsContentSourceRecordsCollection().limit(REBUILD_SCAN_LIMIT).get();
  const contentRecords: AnalyticsContentSourceRecordDoc[] = [];
  for (const doc of contentSnapshot.docs) {
    const parsed = analyticsContentSourceRecordDocSchema.safeParse(doc.data());
    if (parsed.success) contentRecords.push(parsed.data);
  }

  const channelSnapshot = await analyticsChannelSourceRecordsCollection().limit(REBUILD_SCAN_LIMIT).get();
  const channelRecords: AnalyticsChannelSourceRecordDoc[] = [];
  for (const doc of channelSnapshot.docs) {
    const parsed = analyticsChannelSourceRecordDocSchema.safeParse(doc.data());
    if (parsed.success) channelRecords.push(parsed.data);
  }

  const platformTotals = aggregatePlatformTotals(contentRecords);
  const sourceRecordCountsByPlatform = aggregateSourceRecordCountsByPlatform([...contentRecords, ...channelRecords]);
  const interactionsByPlatform = aggregateInteractionsByPlatform(contentRecords);
  const contentExceptions = aggregateIngestionExceptionCounts(contentRecords);
  const channelExceptions = aggregateIngestionExceptionCounts(channelRecords);
  const freshnessByPlatform = aggregateFreshnessByPlatform([...contentRecords, ...channelRecords]);

  const snapshot: AnalyticsReadModelSnapshotDoc = analyticsReadModelSnapshotDocSchema.parse({
    uid: GLOBAL_SNAPSHOT_UID,
    scope: "GLOBAL",
    computedAt: new Date().toISOString(),
    platformTotals,
    sourceRecordCountsByPlatform,
    interactionsByPlatform,
    ingestionExceptionCounts: { unmatched: contentExceptions.unmatched + channelExceptions.unmatched, ambiguous: contentExceptions.ambiguous + channelExceptions.ambiguous },
    freshnessByPlatform,
  });

  await analyticsReadModelSnapshotsCollection().doc(GLOBAL_SNAPSHOT_UID).set(snapshot);
  return { ok: true, data: snapshot };
}

export async function getGlobalAnalyticsReadModelSnapshot(): Promise<AnalyticsReadModelSnapshotDoc | null> {
  const snap = await analyticsReadModelSnapshotsCollection().doc(GLOBAL_SNAPSHOT_UID).get();
  if (!snap.exists) return null;
  const parsed = analyticsReadModelSnapshotDocSchema.safeParse(snap.data());
  return parsed.success ? parsed.data : null;
}

export { ANALYTICS_METRIC_REGISTRY };
