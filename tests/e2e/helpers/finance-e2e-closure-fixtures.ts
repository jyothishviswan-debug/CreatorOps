import { createFinanceFixtures, SUPPORTED_READY_DECISIONS, type FinanceFixtures } from "./finance-agreements-fixtures";
import { createFixtures as createReviewFixtures } from "./partner-reviews-fixtures";
import type { FieldDecisionSeed } from "@/server/finance-agreements/testing/agreement-service-fixtures";

// Step 17C: the ONE canonical Finance end-to-end fixture, composed on TOP of the Agreements (Step
// 14B, finance-agreements-fixtures.ts) and Partner Reviews (Step 5B, partner-reviews-fixtures.ts)
// fixture factories - the same layering idiom finance-payables-fixtures.ts / finance-invoices-fixtures.ts /
// finance-payments-fixtures.ts already use on top of EACH OTHER (see each file's own header comment).
//
// Unlike createPayablesFixtures' two canned bases (DETERMINISTIC / FINANCE_REVIEW_REQUIRED, both built
// through partner-reviews-fixtures' seedDirectReview shortcut, which always seeds ZERO delivered
// evidence - see that function's own header comment), this basis proves the ACTUAL Step 15C proration
// rule with a concrete worked example straight from the Step 17C spec (section 5):
//
//     Agreement monthly fixed amount = INR 100,000 (amountMinor 10,000,000)
//     Required monthly deliverables  = 20
//     Actual Analytics-derived, FINALIZED, evaluated delivery = 16 (16 real APPROVED Content threads)
//     -> serviceBaseMinor = 10,000,000 / 20 * 16 = 8,000,000 (INR 80,000)
//
// The 16 delivered threads are real Content documents seeded through partner-reviews-fixtures'
// own seedAssignment/seedThread builders and evaluated through the REAL generate -> submit ->
// finalize Partner Review pipeline (never seedDirectReview) - exactly the mechanism Payables'
// amount-determination.ts documents as the ONLY source it ever reads a monthly count from (never
// Content directly - see that file's header comment and the Step 17C spec section 5/22).
export const CLOSURE_REQUIRED_COUNT = 20;
export const CLOSURE_ACTUAL_COUNT = 16;
export const CLOSURE_FIXED_AMOUNT_MINOR = 10_000_000; // INR 100,000
export const CLOSURE_SERVICE_BASE_MINOR = (CLOSURE_FIXED_AMOUNT_MINOR / CLOSURE_REQUIRED_COUNT) * CLOSURE_ACTUAL_COUNT; // 8,000,000 (INR 80,000)
export const CLOSURE_UNIT = "approved_content_thread";
export const CLOSURE_GST_RATE_BPS = 1800; // 18%, an explicit Finance decision (never defaulted)

export function createClosureFixtures(tag: string) {
  const finance: FinanceFixtures = createFinanceFixtures(tag);
  const reviews = createReviewFixtures(tag);

  // Same complete decision set Payables' own e2e fixtures use (SUPPORTED_READY_DECISIONS), with the
  // three commercial terms this worked example actually needs overridden: a bigger fixed amount, the
  // required count from the spec's own example, and the incentive turned off so the base proration
  // result stays unambiguous (no unmeasured-incentive Finance-review item alongside it).
  const CLOSURE_SEEDS: FieldDecisionSeed[] = SUPPORTED_READY_DECISIONS.map((seed) =>
    seed.fieldKey === "fixedComponent"
      ? { fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: CLOSURE_FIXED_AMOUNT_MINOR } }
      : seed.fieldKey === "monthlyRequiredQualifyingContentCount"
        ? { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "CORRECTED", value: CLOSURE_REQUIRED_COUNT }
        : seed.fieldKey === "incentive"
          ? { fieldKey: "incentive", decision: "NOT_APPLICABLE" }
          : seed,
  );

  // A Partner with an ACTIVE Agreement carrying the worked example's commercial terms, 16 real
  // APPROVED Content threads in `periodKey`, and a FINALIZED Partner Review evaluating them (through
  // the real trusted services - never hand-rolled evidence).
  async function seedProratedPartnerBasis(periodKey: string, displayName: string) {
    await finance.grantFixtureRegion();
    await reviews.grantFixtureRegion();
    const partner = await finance.seedPartner({ displayName });
    const active = await finance.seedActive(finance.partnerCp(partner), CLOSURE_SEEDS);

    for (let i = 0; i < CLOSURE_ACTUAL_COUNT; i += 1) {
      const assignment = await reviews.seedAssignment(partner.partnerRef, { dueAt: `${periodKey}-10` });
      await reviews.seedThread(assignment, { month: periodKey, status: "APPROVED", approvedAt: `${periodKey}-09T00:00:00.000Z`, url: `https://instagram.com/p/closure-${tag}-${i}` });
    }

    const { reviewRef, review } = await reviews.generateInReview(partner.partnerRef, periodKey);
    const finalized = await reviews.finalize(reviewRef, review.selectedVersion!.docVersion);

    return { partner, agreementRef: active.head.agreementRef, agreementVersion: active.selectedVersion!.version, reviewRef, reviewVersion: finalized.selectedVersion!.version, periodKey };
  }

  async function cleanupAll() {
    await reviews.cleanupAll();
    await finance.cleanupAll();
  }

  return { finance, reviews, seedProratedPartnerBasis, cleanupAll };
}

export type ClosureFixtures = ReturnType<typeof createClosureFixtures>;
