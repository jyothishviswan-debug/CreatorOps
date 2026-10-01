import type { AnalyticsChannelSourceRecordDoc } from "@/server/analytics/types";
import { ANALYTICS_METRIC_IDS, ANALYTICS_METRIC_REGISTRY, type AnalyticsMetricId } from "@/server/analytics/metric-registry";

import { unavailableDeliverable, unavailableLfcSfc } from "./commercial-neutral";
import type { CommercialPolicyConflict, GoverningCommercialPolicy } from "./commercial-policy";
import { parseLeadingUtcDate, type ReviewPeriod } from "./period";
import {
  COMMERCIAL_EVIDENCE_POLICY_VERSION,
  QUALIFYING_UNITS,
  commercialEvidenceSchema,
  type CommercialEvidence,
  type EvidenceCountUnit,
  type EvidenceLfcSfc,
  type EvidenceLfcSfcUnit,
  type EvidenceMonthlyDeliverable,
  type EvidencePerformanceRecord,
  type EvidenceProductionAssignment,
  type EvidenceTarget,
  type QualifyingUnit,
} from "./types";

// Step 13A.1 (revised): the ONE pure builder of the snapshot's `commercial`
// section - monthly deliverable, LFC/SFC classification and warning-only
// targets. No I/O, no clock. It takes the SAME already-canonical in-period
// evidence the rest of the snapshot is built from, plus the governing policy
// (or null), and returns evidence only:
//   - never a monetary value or any financial calculation;
//   - never an invented requirement/count/classification/target - everything
//     Agreement-governed is copied from the policy, and where the policy is
//     silent the section says `unavailable`, with a typed reason code;
//   - never a blended/composite figure, and a target result can never change
//     the deliverable or LFC/SFC results (they are computed independently).

// --- Units the deliverable / LFC-SFC count over -------------------------------
export const SUPPORTED_QUALIFYING_UNITS: readonly string[] = QUALIFYING_UNITS;

export function isSupportedQualifyingUnit(value: string): value is QualifyingUnit {
  return SUPPORTED_QUALIFYING_UNITS.includes(value);
}

// A qualifying unit source is canonical APPROVED Content evidence ONLY: an
// in-period, non-cancelled Assignment's own APPROVED Content thread(s). A
// raw submitted URL, or the links of a thread that is OPEN /
// UNDER_REVIEW / REVISION_REQUESTED / CANCELLED, never count.
//
// Finding #50 (reopened): an Assignment can now carry SEVERAL Content
// threads (one per submission cycle) - every one of them that reached
// APPROVED contributes its own unit independently, never collapsed to at
// most one per Assignment.
//
// assignmentRef/contentRef are always REAL non-null strings here (never the analytics_post identity
// shape) - narrowed back from EvidenceCountUnit's own now-nullable fields (see types.ts) so every
// thread-based caller keeps working without a cast.
type ThreadCountUnit = Omit<EvidenceCountUnit, "assignmentRef" | "contentRef"> & { assignmentRef: string; contentRef: string };

export function qualifyingThreadUnits(production: readonly EvidenceProductionAssignment[], unit: QualifyingUnit): Array<ThreadCountUnit & { formats: string[] }> {
  const units: Array<ThreadCountUnit & { formats: string[] }> = [];
  for (const assignment of production) {
    if (assignment.cancelled) continue;
    for (const thread of assignment.threads) {
      if (thread.status !== "APPROVED") continue;
      units.push({
        assignmentRef: assignment.assignmentRef,
        contentRef: thread.contentRef,
        sourceRecordRef: null,
        unitCount: unit === "approved_current_link" ? thread.linkCount : 1,
        formats: assignment.formats,
      });
    }
  }
  return units;
}

function stripFormats(units: Array<ThreadCountUnit & { formats: string[] }>): EvidenceCountUnit[] {
  return units.map(({ assignmentRef, contentRef, unitCount }) => ({ assignmentRef, contentRef, sourceRecordRef: null, unitCount }));
}

// Finding #30 (user-decided): the monthly commercial fulfillment counter for an Agreement governed by
// "qualifying_analytics_post" - a DISTINCT counter from Assignment/Content-thread fulfillment above
// (qualifyingThreadUnits), based on distinct Analytics posts matched to the Partner/Partner Account
// (a resolved matchedPartnerAccountRef - see import-pipeline.ts's buildContentRowOutcome for the full
// matching hierarchy that produces it; a missing Content/Assignment thread never by itself excludes a
// post here). Distinctness is on normalized platform + post URL - a defensive, self-contained key
// computed here, never the stored doc's own row identity (which folds in reportingPeriod, and so is not
// safe to treat as "the same real post" across imports). When the same distinct post has more than one
// source record (a correction or a duplicate that slipped past row-identity for any reason), the LOWEST
// sourceRecordRef is the deterministic canonical one - never "whichever happened to be first in this
// particular input order".
//
// Finding #57 correction: this counter no longer also requires `matchState === "MATCHED"`. Before #57,
// an Account-only (Content-unmatched) ownership resolution was silently PROMOTED to matchState
// "MATCHED" as a side effect, which is what let the old matchState check here work at all - #57 stopped
// that promotion (a row now stays honestly Content-unmatched even when ownership resolved), so gating
// on matchState here would have silently EXCLUDED exactly the spontaneous/unassigned posts this
// counter's own original comment above already says must count. matchedPartnerAccountRef alone is a
// real, independent, deterministic Account-identity signal (partner-account-matcher.ts never leaves it
// set for an AMBIGUOUS or UNMATCHED account match), so it is sufficient on its own.
export function qualifyingAnalyticsPostUnits(records: readonly EvidencePerformanceRecord[]): Array<{ sourceRecordRef: string; unitCount: number }> {
  const refsByKey = new Map<string, string[]>();
  for (const record of records) {
    if (record.matchedPartnerAccountRef === null) continue;
    if (!record.postUrl) continue;
    const key = `${record.platform}|${record.postUrl}`;
    const refs = refsByKey.get(key) ?? [];
    refs.push(record.sourceRecordRef);
    refsByKey.set(key, refs);
  }
  const units = [...refsByKey.values()].map((refs) => ({ sourceRecordRef: [...refs].sort()[0]!, unitCount: 1 }));
  return units.sort((a, b) => (a.sourceRecordRef < b.sourceRecordRef ? -1 : 1));
}

// --- Monthly deliverable ---------------------------------------------------------
export type CommercialBuildInput = {
  partnerRef: string;
  period: ReviewPeriod;
  policy: GoverningCommercialPolicy | null;
  // Step 14C: set (with a null policy) when more than one applicable Agreement governs the month.
  policyConflict?: Pick<CommercialPolicyConflict, "reason" | "agreementRefs"> | null;
  // Canonical in-period Production rows and Performance records (already
  // built by the evidence builder).
  production: readonly EvidenceProductionAssignment[];
  records: readonly EvidencePerformanceRecord[];
  // True when an Assignment read was capped: a count over it could be an
  // undercount, so the count-based sections refuse to evaluate.
  assignmentsTruncated: boolean;
  // True when an Analytics read was capped (metric sums could be undercounts).
  analyticsTruncated: boolean;
  // Channel snapshot records for the Partner - only supplied when the policy
  // asks for followerGrowth.
  channelRecords: readonly ChannelSnapshotRecordSource[];
  channelScanTruncated: boolean;
};

export type ChannelSnapshotRecordSource = Pick<
  AnalyticsChannelSourceRecordDoc,
  "sourceRef" | "platform" | "profileFollowers" | "reportingPeriod" | "matchState" | "matchedPartnerRef" | "matchedPartnerAccountRef" | "correctionRevision" | "createdAt"
>;

function evaluateMonthlyDeliverable(input: CommercialBuildInput): EvidenceMonthlyDeliverable {
  const { policy } = input;
  const requirement = policy?.monthlyDeliverableRequirement;
  // requiredCount is ONLY ever copied from the policy - never invented,
  // never defaulted. No policy / no requirement -> unavailable.
  if (!policy || !requirement) return unavailableDeliverable("no_agreement_requirement");

  const requirementSource = { agreementRef: policy.agreementRef, agreementVersion: policy.agreementVersion, requirementSourceRef: requirement.requirementSourceRef ?? null };
  const copied = { requiredCount: requirement.requiredCount, requirementSource };

  if (!isSupportedQualifyingUnit(requirement.qualifyingUnit)) return unavailableDeliverable("unsupported_qualifying_unit", copied);

  const unit = requirement.qualifyingUnit;

  // Finding #30 (user-decided): a DELIBERATELY SEPARATE counting basis - distinct matched Analytics
  // posts, never Assignment/Content-thread evidence. See qualifyingAnalyticsPostUnits' own comment.
  if (unit === "qualifying_analytics_post") {
    if (input.analyticsTruncated) return unavailableDeliverable("evidence_truncated", { ...copied, qualifyingUnit: unit });
    const counted = qualifyingAnalyticsPostUnits(input.records);
    const actual = counted.length;
    const variance = actual - requirement.requiredCount;
    return {
      ...copied,
      qualifyingUnit: unit,
      actualQualifyingCount: actual,
      actualCountSources: {
        sourceType: "analytics_post",
        units: counted.map(({ sourceRecordRef, unitCount }) => ({ assignmentRef: null, contentRef: null, sourceRecordRef, unitCount })),
      },
      variance,
      evaluation: variance === 0 ? "met" : variance < 0 ? "below_requirement" : "exceeded",
      unavailableReason: null,
      affectsPayment: true,
    };
  }

  if (input.assignmentsTruncated) return unavailableDeliverable("evidence_truncated", { ...copied, qualifyingUnit: unit });

  const counted = qualifyingThreadUnits(input.production, unit);
  const actual = counted.reduce((sum, entry) => sum + entry.unitCount, 0);
  const variance = actual - requirement.requiredCount;

  return {
    ...copied,
    qualifyingUnit: unit,
    actualQualifyingCount: actual,
    actualCountSources: { sourceType: unit === "approved_current_link" ? "content_link" : "content_thread", units: stripFormats(counted) },
    variance,
    evaluation: variance === 0 ? "met" : variance < 0 ? "below_requirement" : "exceeded",
    unavailableReason: null,
    // Payment-affecting ONLY because the requirement came from an Agreement policy.
    affectsPayment: true,
  };
}

// --- LFC / SFC ----------------------------------------------------------------------
function normalizeFormat(value: string): string {
  return value.trim().toLowerCase();
}

// Classifies ONE Assignment's brief formats against a rule: exact
// case-insensitive (after trim) match of ANY brief format against the rule's
// keys. No match, or matches that resolve to BOTH classes, is `unclassified`
// - never guessed from platform, URL count, names or anything else.
export function classifyFormats(formats: readonly string[], byFormat: Readonly<Record<string, "LFC" | "SFC">>): { classification: "LFC" | "SFC" | "unclassified"; matchedFormat: string | null } {
  const ruleByKey = new Map<string, Set<"LFC" | "SFC">>();
  for (const [format, classification] of Object.entries(byFormat)) {
    const key = normalizeFormat(format);
    const set = ruleByKey.get(key) ?? new Set<"LFC" | "SFC">();
    set.add(classification);
    ruleByKey.set(key, set);
  }

  const matched = new Map<string, "LFC" | "SFC">();
  let conflict = false;
  for (const format of formats) {
    const classes = ruleByKey.get(normalizeFormat(format));
    if (!classes) continue;
    if (classes.size > 1) {
      // The rule itself maps this format to both classes: ambiguous.
      conflict = true;
      continue;
    }
    matched.set(normalizeFormat(format), [...classes][0]!);
  }

  const distinct = new Set(matched.values());
  if (conflict || distinct.size !== 1) return { classification: "unclassified", matchedFormat: null };
  const [firstKey] = [...matched.keys()].sort();
  return { classification: [...distinct][0]!, matchedFormat: firstKey! };
}

function evaluateLfcSfc(input: CommercialBuildInput): EvidenceLfcSfc {
  const { policy } = input;
  const rule = policy?.lfcSfcRule;
  if (!policy || !rule) return unavailableLfcSfc("no_agreement_rule");

  const ruleSource = { agreementRef: policy.agreementRef, agreementVersion: policy.agreementVersion };
  const requirement = policy.monthlyDeliverableRequirement;

  // The SAME qualifying definition as the deliverable count; without an
  // Agreement requirement the documented default is used and recorded.
  let unit: QualifyingUnit = "approved_content_thread";
  let unitSource: EvidenceLfcSfc["qualifyingUnitSource"] = "default_approved_content_thread";
  if (requirement) {
    if (!isSupportedQualifyingUnit(requirement.qualifyingUnit)) return unavailableLfcSfc("unsupported_qualifying_unit", { ruleRef: rule.ruleRef, ruleSource });
    unit = requirement.qualifyingUnit;
    unitSource = "agreement_requirement";
  }

  // Finding #30 (user-decided): LFC/SFC format classification is inherently a Content-thread concept -
  // it classifies an Assignment's OWN brief formats. An Agreement governed by the Analytics-post unit has
  // no thread/format basis to classify at all, so this is honestly unavailable rather than silently
  // reinterpreted as a content-thread count (qualifyingThreadUnits has no meaning for this unit).
  if (unit === "qualifying_analytics_post") return unavailableLfcSfc("qualifying_unit_not_applicable_to_lfc_sfc", { ruleRef: rule.ruleRef, ruleSource, qualifyingUnit: unit, qualifyingUnitSource: unitSource });

  if (input.assignmentsTruncated) return unavailableLfcSfc("evidence_truncated", { ruleRef: rule.ruleRef, ruleSource, qualifyingUnit: unit, qualifyingUnitSource: unitSource });

  const units: EvidenceLfcSfcUnit[] = [];
  let lfc = 0;
  let sfc = 0;
  let unclassified = 0;
  for (const entry of qualifyingThreadUnits(input.production, unit)) {
    const result = classifyFormats(entry.formats, rule.byFormat);
    units.push({
      assignmentRef: entry.assignmentRef,
      contentRef: entry.contentRef,
      unitCount: entry.unitCount,
      classification: result.classification,
      basis: { ruleRef: rule.ruleRef, matchedFormat: result.matchedFormat },
    });
    if (result.classification === "LFC") lfc += entry.unitCount;
    else if (result.classification === "SFC") sfc += entry.unitCount;
    else unclassified += entry.unitCount;
  }

  return {
    status: "evaluated",
    unavailableReason: null,
    ruleRef: rule.ruleRef,
    ruleSource,
    qualifyingUnit: unit,
    qualifyingUnitSource: unitSource,
    lfcCount: lfc,
    sfcCount: sfc,
    unclassifiedCount: unclassified,
    units,
    affectsPayment: rule.affectsPayment,
  };
}

// --- Targets (WARNING ONLY) ----------------------------------------------------------
// Content metrics a target may name: the accepted registry's COUNT metrics
// EXCEPT profileFollowers. A follower count is a point-in-time ACCOUNT
// snapshot, not an additive per-post figure, so summing it over posts would be
// meaningless; the honest follower target is the derived `followerGrowth`.
const NON_ADDITIVE_COUNT_METRICS: readonly AnalyticsMetricId[] = ["profileFollowers"];
export const TARGET_CONTENT_METRIC_IDS: readonly AnalyticsMetricId[] = ANALYTICS_METRIC_IDS.filter((id) => ANALYTICS_METRIC_REGISTRY[id].kind === "count" && !NON_ADDITIVE_COUNT_METRICS.includes(id));
export const FOLLOWER_GROWTH_METRIC_ID = "followerGrowth";

type PolicyTarget = NonNullable<GoverningCommercialPolicy["targets"]>[number];

function targetBase(target: PolicyTarget): Pick<EvidenceTarget, "targetRef" | "metricId" | "targetValue" | "unit" | "comparison" | "affectsPayment"> {
  return { targetRef: target.targetRef, metricId: target.metricId, targetValue: target.targetValue, unit: target.unit, comparison: target.comparison, affectsPayment: false };
}

function unavailableTarget(target: PolicyTarget, reason: string, provenance: Partial<EvidenceTarget["provenance"]> = {}): EvidenceTarget {
  return {
    ...targetBase(target),
    actualValue: null,
    evaluation: "unavailable",
    unavailableReason: reason,
    provenance: { sourceType: "analytics_source_record", refs: [], recordsWithMetric: 0, recordsMissingMetric: 0, ...provenance },
  };
}

// content metrics: actual = sum over in-period MATCHED records that HAVE the
// metric. Missing is never zero. A shortfall on incomplete data is never
// `not_met` (the shortfall may be missing data), but a sum that already
// reaches the target is `met` (a lower bound already satisfies it).
function evaluateContentMetricTarget(target: PolicyTarget, records: readonly EvidencePerformanceRecord[], analyticsTruncated: boolean): EvidenceTarget {
  const considered = records.filter((record) => record.provenance.matchState === "MATCHED");
  const withMetric = considered.filter((record) => record.metrics[target.metricId] !== null && record.metrics[target.metricId] !== undefined);
  const provenance = {
    refs: withMetric.map((record) => record.sourceRecordRef),
    recordsWithMetric: withMetric.length,
    recordsMissingMetric: considered.length - withMetric.length,
  };
  if (withMetric.length === 0) return unavailableTarget(target, "no_verified_values", { recordsMissingMetric: provenance.recordsMissingMetric });

  const sum = withMetric.reduce((total, record) => total + (record.metrics[target.metricId] as number), 0);
  const incomplete = provenance.recordsMissingMetric > 0 || analyticsTruncated;
  if (sum >= target.targetValue) return { ...targetBase(target), actualValue: sum, evaluation: "met", unavailableReason: null, provenance: { sourceType: "analytics_source_record", ...provenance } };
  if (incomplete) return unavailableTarget(target, "incomplete_metric_coverage", provenance);
  return { ...targetBase(target), actualValue: sum, evaluation: "not_met", unavailableReason: null, provenance: { sourceType: "analytics_source_record", ...provenance } };
}

// The channel snapshot records that COULD feed followerGrowth for this
// Partner + period: MATCHED to this Partner AND to a Partner Account, with a
// confidently parseable reporting period whose END date (the snapshot's
// as-of date) falls inside [periodStart, periodEnd] inclusive. Shared by the
// evaluation and by the fingerprint, so the fingerprint covers exactly the
// records the evaluation reads (an out-of-period upload changes nothing).
export function selectFollowerSnapshotCandidates<T extends ChannelSnapshotRecordSource>(partnerRef: string, period: ReviewPeriod, records: readonly T[]): Array<{ record: T; asOf: string }> {
  const selected: Array<{ record: T; asOf: string }> = [];
  for (const record of records) {
    if (record.matchedPartnerRef !== partnerRef || record.matchState !== "MATCHED" || record.matchedPartnerAccountRef === null) continue;
    if (!record.reportingPeriod) continue;
    const start = parseLeadingUtcDate(record.reportingPeriod.start);
    const end = parseLeadingUtcDate(record.reportingPeriod.end);
    if (!start || !end || start > end) continue;
    if (end < period.periodStart || end > period.periodEnd) continue;
    selected.push({ record, asOf: end });
  }
  return selected.sort((a, b) => (a.record.sourceRef < b.record.sourceRef ? -1 : a.record.sourceRef > b.record.sourceRef ? 1 : 0));
}

// followerGrowth: derived ONLY from channel snapshot Analytics records (the
// `analyticsChannelSourceRecords` collection: MATCHED to this Partner AND to a
// Partner Account, with a reporting period and a source-reported
// profileFollowers). A snapshot's as-of date is the END of its reporting
// period and must fall inside [periodStart, periodEnd] (inclusive).
//
// Growth for ONE Partner Account = latest - earliest over its DISTINCT as-of
// dates (may be negative). It needs >= 2 distinct verified snapshots of that
// SAME account; the Partner's growth is the sum over its accounts. If ANY
// account that has an in-period snapshot has fewer than 2 distinct dates the
// whole target is unavailable (insufficient_follower_snapshots) - growth is
// never fabricated from a single snapshot. Two snapshots of one account with
// the SAME as-of date but DIFFERENT values contradict each other
// (conflicting_follower_snapshots). A capped channel read is unavailable too.
//
// KNOWN LIMIT (documented, not hidden): a Partner Account with NO in-period
// snapshot at all is not observable here (Partner Reviews holds no account
// inventory), so the figure is the growth of the accounts that have snapshot
// evidence - the provenance lists exactly those source records.
function evaluateFollowerGrowthTarget(target: PolicyTarget, input: CommercialBuildInput): { target: EvidenceTarget; usedRefs: string[] } {
  const period = input.period;
  if (input.channelScanTruncated) return { target: unavailableTarget(target, "channel_scan_truncated"), usedRefs: [] };

  type Snapshot = { ref: string; asOf: string; followers: number };
  const byAccount = new Map<string, Map<string, Snapshot[]>>();
  let missing = 0;

  for (const { record, asOf } of selectFollowerSnapshotCandidates(input.partnerRef, period, input.channelRecords)) {
    if (record.profileFollowers === null || !Number.isFinite(record.profileFollowers)) {
      missing += 1;
      continue;
    }
    const account = record.matchedPartnerAccountRef!;
    const dates = byAccount.get(account) ?? new Map<string, Snapshot[]>();
    const list = dates.get(asOf) ?? [];
    list.push({ ref: record.sourceRef, asOf, followers: record.profileFollowers });
    dates.set(asOf, list);
    byAccount.set(account, dates);
  }

  const withCount = [...byAccount.values()].reduce((total, dates) => total + [...dates.values()].reduce((n, list) => n + list.length, 0), 0);
  if (byAccount.size === 0) return { target: unavailableTarget(target, "insufficient_follower_snapshots", { recordsMissingMetric: missing }), usedRefs: [] };

  let growth = 0;
  const usedRefs: string[] = [];
  for (const dates of byAccount.values()) {
    if (dates.size < 2) return { target: unavailableTarget(target, "insufficient_follower_snapshots", { recordsWithMetric: withCount, recordsMissingMetric: missing }), usedRefs: [] };
    const ordered: Snapshot[] = [];
    for (const asOf of [...dates.keys()].sort()) {
      const list = dates.get(asOf)!;
      if (new Set(list.map((snapshot) => snapshot.followers)).size > 1) return { target: unavailableTarget(target, "conflicting_follower_snapshots", { recordsWithMetric: withCount, recordsMissingMetric: missing }), usedRefs: [] };
      // Same date, same value: one canonical snapshot (lowest ref, deterministic).
      ordered.push([...list].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))[0]!);
    }
    growth += ordered[ordered.length - 1]!.followers - ordered[0]!.followers;
    for (const snapshot of ordered) usedRefs.push(snapshot.ref);
  }

  usedRefs.sort();
  return {
    target: {
      ...targetBase(target),
      actualValue: growth,
      evaluation: growth >= target.targetValue ? "met" : "not_met",
      unavailableReason: null,
      provenance: { sourceType: "analytics_source_record", refs: usedRefs, recordsWithMetric: withCount, recordsMissingMetric: missing },
    },
    usedRefs,
  };
}

function evaluateTargets(input: CommercialBuildInput): { targets: EvidenceTarget[]; channelSourceRefs: string[] } {
  const policyTargets = [...(input.policy?.targets ?? [])].sort((a, b) => (a.targetRef === b.targetRef ? (a.metricId < b.metricId ? -1 : 1) : a.targetRef < b.targetRef ? -1 : 1));
  const channelSourceRefs = new Set<string>();
  const targets = policyTargets.map((target): EvidenceTarget => {
    if (target.metricId === FOLLOWER_GROWTH_METRIC_ID) {
      const result = evaluateFollowerGrowthTarget(target, input);
      for (const ref of result.usedRefs) channelSourceRefs.add(ref);
      return result.target;
    }
    // Reach, impressions, shares, saves, watch time, demographics, profileFollowers
    // (non-additive) and anything unknown: honestly unavailable - never `not_met`, never zero.
    if (!(TARGET_CONTENT_METRIC_IDS as readonly string[]).includes(target.metricId)) return unavailableTarget(target, "unsupported_metric");
    return evaluateContentMetricTarget(target, input.records, input.analyticsTruncated);
  });
  return { targets, channelSourceRefs: [...channelSourceRefs].sort() };
}

// --- The section ---------------------------------------------------------------------
export type CommercialBuildResult = {
  commercial: CommercialEvidence;
  // Channel snapshot source record refs that fed an evaluated followerGrowth
  // target (added to the snapshot's own sourceRefs by the evidence builder).
  channelSourceRefs: string[];
};

export function buildCommercialEvidence(input: CommercialBuildInput): CommercialBuildResult {
  // An overlap conflict: nothing Agreement-governed is evaluated, picked or merged. Every section is
  // unavailable with the typed conflict reason; the marker records which Agreement refs collided.
  if (input.policyConflict) {
    const reason = input.policyConflict.reason;
    return {
      commercial: commercialEvidenceSchema.parse({
        policyVersion: COMMERCIAL_EVIDENCE_POLICY_VERSION,
        governingAgreement: null,
        monthlyDeliverable: unavailableDeliverable(reason),
        lfcSfc: unavailableLfcSfc(reason),
        targets: [],
        policyConflict: { reason, agreementRefs: [...input.policyConflict.agreementRefs].sort() },
      }),
      channelSourceRefs: [],
    };
  }

  const { targets, channelSourceRefs } = evaluateTargets(input);
  const commercial = commercialEvidenceSchema.parse({
    policyVersion: COMMERCIAL_EVIDENCE_POLICY_VERSION,
    governingAgreement: input.policy ? { agreementRef: input.policy.agreementRef, agreementVersion: input.policy.agreementVersion } : null,
    // Each section is computed independently: nothing a target says can
    // reach the deliverable or LFC/SFC evaluation.
    monthlyDeliverable: evaluateMonthlyDeliverable(input),
    lfcSfc: evaluateLfcSfc(input),
    targets,
  });
  return { commercial, channelSourceRefs };
}
