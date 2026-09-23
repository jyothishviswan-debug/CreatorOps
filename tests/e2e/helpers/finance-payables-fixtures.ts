import type { Page } from "@playwright/test";

import { getAgreementCommercialPolicy } from "@/server/finance-agreements/policy-adapter";
import type { FieldDecisionSeed } from "@/server/finance-agreements/testing/agreement-service-fixtures";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";

import { createFinanceFixtures, emailFor, PASSWORD, SUPPORTED_READY_DECISIONS, VIEWPORTS, type RoleName } from "./finance-agreements-fixtures";
import { createFixtures as createReviewFixtures } from "./partner-reviews-fixtures";

// Step 15B: e2e fixtures for the Finance Payables UI. Built on TOP of createFinanceFixtures (Step 14B's
// own Agreement fixture factory) and partner-reviews-fixtures' seedDirectReview - same idiom: real,
// schema-valid documents built through the accepted pure builders, one private region per spec tag,
// everything removed in cleanupAll().
//
// Two determination scenarios, both real (no invented backend behavior):
//   - DETERMINISTIC:  a Vendor Agreement (Agreement-only source - no Partner Review evidence exists for a
//     Vendor) with a fixed amount and every other commercial line NOT_APPLICABLE - one BASE_FIXED line,
//     nothing left to review.
//   - FINANCE_REVIEW_REQUIRED: a Partner Agreement (a fixed amount, a structured incentive slab, and a
//     required qualifying-content count) with a finalized Partner Review that has NO seeded
//     delivery/analytics evidence - the qualifying content is under-delivered (a stated fixed fee is
//     never reduced for it) and the incentive slab has no measured metric, so both surface as
//     Finance-review items.
//
// A Playwright TEST PROCESS is a plain Node process, not the running Next dev server: Partner Reviews'
// live commercial-policy DI registration (src/instrumentation.ts's register(), Node-runtime only) never
// runs in it, so generatePartnerReviewDraft would see no governing policy even for a real, active
// Agreement. seedDirectReview sidesteps that exactly the way the existing Partner Reviews e2e specs do -
// it calls the pure adapter (getAgreementCommercialPolicy) directly and writes a schema-valid review
// document carrying that real policy, rather than depending on the provider registry.
export { emailFor, PASSWORD, VIEWPORTS };
export type { RoleName };

export const VENDOR_DETERMINISTIC_SEEDS: FieldDecisionSeed[] = SUPPORTED_READY_DECISIONS.map((seed) => (seed.fieldKey === "incentive" ? { fieldKey: "incentive", decision: "NOT_APPLICABLE" } : seed));

// Same as SUPPORTED_READY_DECISIONS but with performanceTargets NOT_APPLICABLE: the tracked pre-existing
// baseline schema drift (commit 57a932a, see AGENTS/spec section 22 - a target's anchor/period fields)
// makes the STRICT-policy validation fail whenever a governing Agreement states performance targets.
// Targets are warning-only and irrelevant to this fixture's own scenario, so they are left out entirely
// rather than exercising that unrelated, already-tracked bug.
export const PARTNER_REVIEW_REQUIRED_SEEDS: FieldDecisionSeed[] = SUPPORTED_READY_DECISIONS.map((seed) => (seed.fieldKey === "performanceTargets" ? { fieldKey: "performanceTargets", decision: "NOT_APPLICABLE" } : seed));

export function createPayablesFixtures(tag: string) {
  const finance = createFinanceFixtures(tag);
  const reviews = createReviewFixtures(tag);
  const region = `${tag}-region`;
  const reviewRefs = new Set<string>();

  // A finalized Partner Review for `periodKey`, carrying the REAL governing policy of the Partner's own
  // active Agreement (resolved directly through the pure adapter - see the file header). No
  // assignments/content/analytics are seeded, so every payment-affecting delivery item is
  // under-delivered/unmeasured on purpose (see the module header).
  async function seedFinalizedReview(partner: Awaited<ReturnType<typeof finance.seedPartner>>, periodKey: string): Promise<{ reviewRef: string; version: number }> {
    const resolved = await getAgreementCommercialPolicy(partner.partnerRef, periodKey);
    if (!resolved || "kind" in resolved) throw new Error(`getAgreementCommercialPolicy did not resolve a single governing policy for ${partner.partnerRef}/${periodKey}: ${JSON.stringify(resolved)}`);
    const { reviewRef, version } = await reviews.seedDirectReview(partner, periodKey, { status: "FINALIZED", policy: resolved });
    reviewRefs.add(reviewRef);
    return { reviewRef, version: version.version };
  }

  // A DETERMINISTIC Payable basis: a Vendor with an active, fixed-only Agreement.
  async function seedDeterministicVendorBasis(displayName: string): Promise<{ counterpartyType: "VENDOR"; counterpartyRef: string; displayName: string; commercialPeriod: string; agreementRef: string }> {
    await finance.grantFixtureRegion();
    const vendor = await finance.seedVendor({ displayName });
    const active = await finance.seedActive(finance.vendorCp(vendor), VENDOR_DETERMINISTIC_SEEDS);
    return { counterpartyType: "VENDOR", counterpartyRef: vendor.vendorRef, displayName: vendor.displayName, commercialPeriod: "2024-06", agreementRef: active.head.agreementRef };
  }

  // A FINANCE_REVIEW_REQUIRED Payable basis: a Partner with an active, incentive+required-content
  // Agreement and a finalized Review carrying no delivery/analytics evidence.
  async function seedReviewRequiredPartnerBasis(displayName: string): Promise<{ counterpartyType: "PARTNER"; counterpartyRef: string; displayName: string; commercialPeriod: string; agreementRef: string; reviewRef: string }> {
    await finance.grantFixtureRegion();
    const partner = await finance.seedPartner({ displayName });
    const active = await finance.seedActive(finance.partnerCp(partner), PARTNER_REVIEW_REQUIRED_SEEDS);
    const periodKey = "2024-06";
    const review = await seedFinalizedReview(partner, periodKey);
    return { counterpartyType: "PARTNER", counterpartyRef: partner.partnerRef, displayName: partner.displayName, commercialPeriod: periodKey, agreementRef: active.head.agreementRef, reviewRef: review.reviewRef };
  }

  async function cleanupAll() {
    for (const reviewRef of reviewRefs) {
      await getAdminFirestore()
        .recursiveDelete(partnerReviewsCollection().doc(reviewRef))
        .catch(() => undefined);
    }
    await finance.cleanupAll();
  }

  return { finance, region, seedDeterministicVendorBasis, seedReviewRequiredPartnerBasis, cleanupAll };
}

export type PayablesFixtures = ReturnType<typeof createPayablesFixtures>;

export async function signInAs(page: Page, name: RoleName) {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}
