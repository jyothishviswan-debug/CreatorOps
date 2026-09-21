import { POLICY_CONFLICT_REASON, governingCommercialPolicySchema, type CommercialPolicyConflict, type CommercialPolicyProvider, type GoverningCommercialPolicy } from "@/server/partner-reviews/commercial-policy";
import { getPartnerDocByRef } from "@/server/partners/firestore";

import { financeAgreementsCollection, listAgreementVersionDocs } from "./firestore";
import { agreementHeadDocSchema, type AgreementVersionDoc } from "./types";

// Step 14A: the Agreement -> Partner Reviews COMMERCIAL-POLICY ADAPTER.
//
// STATUS (Step 14C): REGISTERED in production. src/server/composition/register-providers.ts (called once per server
// instance from src/instrumentation.ts) registers this function as THE Partner Reviews commercial-policy provider (the
// adapter is exactly a CommercialPolicyProvider). That composition module is the ONLY production importer of this file;
// src/server/partner-reviews (whose boundary tests forbid any Agreement / Finance import) only sees the neutral registry.
//
// WHAT IT IS: a server-only, ACTOR-INDEPENDENT, DETERMINISTIC and TIME-INDEPENDENT function. The
// caller (the trusted Partner Reviews service) has already authorized the actor against the Partner;
// the adapter reads Agreement documents directly, never takes an actor, never reads now(), and never
// writes anything. The same (partnerRef, periodKey) and the same stored Agreement data always give
// the same answer.
//
// WHICH VERSION GOVERNS A MONTH (the documented rule):
//   1. Only PARTNER Agreements of THIS Partner (a head whose stored partnerUid is not the live
//      Partner's uid is ignored, like the list service does). A Vendor Agreement never yields a
//      Partner policy.
//   2. Only CONFIRMED versions in status ACTIVE, SUSPENDED, ENDED or SUPERSEDED. A DRAFT (even a
//      confirmed, not-yet-activated one) never governs.
//   3. A version's GOVERNING RANGE is [effectiveFrom, end] where end is
//        ACTIVE / SUSPENDED   effectiveTo (open-ended when the contract states none). Suspension is a
//                             CreatorOps operational hold, not a change to the contract's terms, so a
//                             suspended version keeps governing the months its range covers.
//        ENDED                the earlier of effectiveTo and the UTC date it was ended (a terminal
//                             lifecycle fact stored on the version, not "now").
//        SUPERSEDED           the earlier of effectiveTo and the day BEFORE its successor version's
//                             effectiveFrom. So a forward revision (v2 from July) leaves v1 governing
//                             the months before July - historical reviews keep their Agreement - while a
//                             same-dates correction (v2 from the same date) leaves v1 governing nothing.
//   4. The version governs a month only if its range COVERS THE WHOLE MONTH (first to last UTC day).
//      A month the range covers only partly (an Agreement starting on the 15th, or ending / being
//      superseded mid-month) has NO governing version: a monthly requirement is never applied to a
//      partial month, and nothing is prorated (there is no money calculation anywhere).
//   5. When several versions of one Agreement cover the month, the HIGHEST version number wins.
//   6. When two DIFFERENT Agreements of the same Partner both govern the month, the answer is
//      ambiguous: the adapter does NOT pick one, does NOT merge and does NOT throw. It returns the neutral
//      conflict object {kind:"conflict", reason:"multiple_applicable_agreements", agreementRefs:[sorted]}, which
//      Partner Reviews shows as unavailable commercial evidence until the overlap is resolved in the Agreement
//      workflow (for example by correcting one Agreement's effective range through a revision; NOTE: ending an
//      Agreement only stops it governing months AFTER its end date, so a month that has already elapsed stays in
//      conflict until an Agreement's range is corrected).
//   7. No governing version => null.
//
// A month that straddles a v1 / v2 boundary (v2 effective mid-month) has NO governing version (rule 4): it reads
// unavailable and is never attributed to either version.
//
// WHAT IT RETURNS: null, the overlap conflict, or the strict GoverningCommercialPolicy (validated before it leaves).
// It carries NO fixed amount, currency, payment cycle or any other money term - only:
//   - agreementRef + agreementVersion of the governing version;
//   - monthlyDeliverableRequirement ONLY when the confirmed terms carry a required count AND a
//     qualifying unit Partner Reviews supports (a free-text unit it cannot evaluate is left out - it is
//     never guessed or mapped);
//   - lfcSfcRule ONLY when the confirmed terms state an explicit format -> LFC/SFC rule;
//   - targets: the confirmed performance targets, every one warning-only (affectsPayment is the
//     literal false in the Agreement schema, and the policy shape carries no payment flag at all).

// Partner Reviews' supported qualifying units (partner-reviews/types QUALIFYING_UNITS). Kept as a
// local list because the Finance boundary allows exactly ONE Partner Reviews import (the policy
// contract); policy-adapter.test.ts pins this list to the Partner Reviews constant so it cannot drift.
export const PARTNER_REVIEW_QUALIFYING_UNITS = ["approved_content_thread", "approved_current_link"] as const;

// A Partner with more Agreement heads than this is an anomaly, not a normal book: fail loud.
export const MAX_ADAPTER_AGREEMENT_HEADS = 50;

// Thrown for genuine anomalies (an implausible number of Agreements for one Partner, a policy that fails the strict
// contract). An overlap is NOT an error: it is the conflict answer.
export class AgreementPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgreementPolicyError";
  }
}

const GOVERNING_STATUSES: ReadonlySet<AgreementVersionDoc["status"]> = new Set(["ACTIVE", "SUSPENDED", "ENDED", "SUPERSEDED"]);

type MonthBounds = { first: string; last: string };

function monthBounds(periodKey: unknown): MonthBounds | null {
  if (typeof periodKey !== "string") return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${match[1]}-${match[2]}-01`, last: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}` };
}

function dayBefore(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

const earlier = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

// The last UTC date the version governs (null = open-ended), or "none" when it cannot be determined
// (a SUPERSEDED version whose successor is missing is never trusted to govern).
function governingEnd(version: AgreementVersionDoc, byNumber: Map<number, AgreementVersionDoc>): string | null | "none" {
  const effectiveTo = version.effective?.effectiveTo ?? null;
  if (version.status === "ENDED") return earlier(effectiveTo, version.endedAt ? version.endedAt.slice(0, 10) : null);
  if (version.status === "SUPERSEDED") {
    const successor = version.supersededByVersion === null ? undefined : byNumber.get(version.supersededByVersion);
    const successorFrom = successor?.effective?.effectiveFrom;
    if (!successorFrom) return "none";
    return earlier(effectiveTo, dayBefore(successorFrom));
  }
  return effectiveTo;
}

function coversMonth(version: AgreementVersionDoc, byNumber: Map<number, AgreementVersionDoc>, month: MonthBounds): boolean {
  if (!GOVERNING_STATUSES.has(version.status) || !version.confirmation || !version.terms || !version.effective) return false;
  const end = governingEnd(version, byNumber);
  if (end === "none") return false;
  return version.effective.effectiveFrom <= month.first && (end === null || end >= month.last);
}

function buildPolicy(agreementRef: string, version: AgreementVersionDoc): GoverningCommercialPolicy {
  const terms = version.terms!;
  const { commercial } = terms;
  const sourceRef = `${agreementRef}@${version.version}`;
  const policy: GoverningCommercialPolicy = { agreementRef, agreementVersion: version.version };

  if (commercial.monthlyRequiredQualifyingContentCount !== null && commercial.qualifyingUnit !== null && (PARTNER_REVIEW_QUALIFYING_UNITS as readonly string[]).includes(commercial.qualifyingUnit)) {
    policy.monthlyDeliverableRequirement = { requiredCount: commercial.monthlyRequiredQualifyingContentCount, qualifyingUnit: commercial.qualifyingUnit, requirementSourceRef: sourceRef };
  }

  if (commercial.lfcSfc) {
    // `affectsPayment: true` is the literal Partner Reviews' rule shape demands (a classification rule feeds
    // payment-relevant evidence); it is a property of that contract, not something the Agreement decides here.
    policy.lfcSfcRule = { ruleRef: commercial.lfcSfc.ruleRef ?? `${sourceRef}:lfc-sfc`, byFormat: { ...commercial.lfcSfc.byFormat }, affectsPayment: true };
  }

  if (terms.performanceTargets.length > 0) {
    policy.targets = terms.performanceTargets.map((target) => {
      // Warning-only by construction (the Agreement schema stores the literal false); assert it again at the seam.
      if (target.affectsPayment !== false) throw new AgreementPolicyError("A performance target claims to affect payment; targets are warning-only.");
      return { targetRef: target.targetRef, metricId: target.metricId, targetValue: target.targetValue, unit: target.unit, comparison: target.comparison };
    });
  }
  return policy;
}

// (partnerRef, periodKey) -> the strict policy of the Agreement version governing that month, the overlap conflict, or null.
export async function getAgreementCommercialPolicy(partnerRef: string, periodKey: string): Promise<GoverningCommercialPolicy | CommercialPolicyConflict | null> {
  const month = monthBounds(periodKey);
  if (!month || typeof partnerRef !== "string" || partnerRef.length === 0) return null;

  const partner = await getPartnerDocByRef(partnerRef);
  if (!partner) return null;

  // Equality-only on one field (no composite index), bounded.
  const snapshot = await financeAgreementsCollection()
    .where("counterparty.partnerRef", "==", partnerRef)
    .limit(MAX_ADAPTER_AGREEMENT_HEADS + 1)
    .get();
  if (snapshot.docs.length > MAX_ADAPTER_AGREEMENT_HEADS) throw new AgreementPolicyError("A Partner has more Agreements than the adapter can consider.");

  const governing: Array<{ agreementRef: string; version: AgreementVersionDoc }> = [];
  for (const doc of snapshot.docs) {
    const head = agreementHeadDocSchema.safeParse(doc.data());
    if (!head.success || head.data.counterparty.type !== "PARTNER" || head.data.partnerUid !== partner.uid) continue;

    const listed = await listAgreementVersionDocs(head.data.agreementRef);
    const byNumber = new Map(listed.versions.map((version) => [version.version, version] as const));
    const covering = listed.versions.filter((version) => coversMonth(version, byNumber, month));
    if (covering.length === 0) continue;
    // Highest version number wins within one Agreement (the list is newest-first).
    const best = covering.reduce((winner, candidate) => (candidate.version > winner.version ? candidate : winner));
    governing.push({ agreementRef: head.data.agreementRef, version: best });
  }

  if (governing.length === 0) return null;
  if (governing.length > 1) {
    const agreementRefs = governing.map((entry) => entry.agreementRef).sort();
    return { kind: "conflict", reason: POLICY_CONFLICT_REASON, agreementRefs };
  }

  const only = governing[0]!;
  const parsed = governingCommercialPolicySchema.safeParse(buildPolicy(only.agreementRef, only.version));
  if (!parsed.success) throw new AgreementPolicyError(`The Agreement commercial policy failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

// The adapter IS a CommercialPolicyProvider; this alias is what a test (or the deferred production
// registration) hands to setCommercialPolicyProviderForTests.
export const agreementCommercialPolicyProvider: CommercialPolicyProvider = getAgreementCommercialPolicy;
