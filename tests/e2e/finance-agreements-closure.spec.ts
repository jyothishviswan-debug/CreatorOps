import { createHash } from "node:crypto";

import { test, type Locator, type Page } from "@playwright/test";

import {
  collectBrowserErrors,
  collectResponseBodies,
  createFinanceFixtures,
  noDocumentOverflow,
  renderedDom,
  signInAs,
  SUPPORTED_READY_DECISIONS,
  uniqueIdentity,
  VIEWPORTS,
  waitForHydration,
  type FinanceFixtures,
} from "./helpers/finance-agreements-fixtures";
import { createFixtures } from "./helpers/partner-reviews-fixtures";
import { checkDuplicates, expect, extractInWizard, openNewAgreement, openWizard, pdfFile, radio } from "./helpers/finance-onboarding-helpers";
import { createAgreementRevision, endAgreement, getAgreementDetail } from "@/server/finance-agreements";
import { financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { partnerReviewsCollection, PARTNER_REVIEWS_COLLECTIONS } from "@/server/partner-reviews/firestore";
import { reviewRefFor } from "@/server/partner-reviews/period";
import { getAdminFirestore } from "@/server/firebase/admin";
import { restrictedFinancialIdentitiesCollection, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";

// Step 14C - FINANCE AGREEMENTS CLOSURE (browser certification). Real Next dev server (src/instrumentation.ts register() runs at its start with the
// private emulator env), private Firestore/Auth/Storage emulators, the FAKE Drive adapter (FINANCE_AGREEMENT_DRIVE_MODE=fake - links are
// https://drive.invalid/fake/<id>, the live adapter is never reached). Hermetic: private-region fixtures, a unique tag, everything removed in afterAll.
//
//   1. REAL-REGISTRATION PROOF: an ACTIVE Agreement (required count + supported unit, explicit LFC/SFC, a warning-only target AND a fixed amount) governs a
//      Partner-month; a Review generated THROUGH THE UI shows Agreement-governed commercial evidence and no money anywhere; an overlapping second Agreement
//      turns it into "Multiple applicable Agreements require resolution" after a refresh (no crash); the overlap is resolved in the Agreement workflow.
//   5. DEPENDENCY GUARD through the UI + API for Partner (archive, blacklist) and Vendor (archive); INACTIVE is unaffected.
// The existing-counterparty and new Partner / Vendor closure journeys follow in the later describe blocks.

test.describe.configure({ mode: "serial" });

const TAG = `FCL${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);
const pr = createFixtures(TAG); // Partner Reviews evidence fixtures (Assignments / Content / Analytics); same private region as `fx`
const SHOTS14C = "/private/tmp/claude-501/-Users-jyothishviswan-Documents-GitHub-CreatorOps/f6532d82-64bb-46ec-b66b-e42c0c3b6670/scratchpad/shots14c";
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `${SHOTS14C}/${name}.png`, fullPage });
const shotEl = async (locator: Locator, name: string) => {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: `${SHOTS14C}/${name}.png` });
};

// A distinctive fixed amount (integer minor units): 76,543.21 - no number derived from it may reach Partner Reviews.
const FIXED_MINOR = 7_654_321;
const MONTH = "2018-06"; // this spec's own past month
const withTerms = (over: Record<string, unknown>) =>
  SUPPORTED_READY_DECISIONS.map((seed) => (seed.fieldKey in over ? { ...seed, decision: "CORRECTED" as const, value: over[seed.fieldKey] } : seed));
const GOVERNING_TERMS = withTerms({
  effectiveDate: "2018-01-01",
  terminationDate: "2018-12-31",
  monthlyRequiredQualifyingContentCount: 2,
  qualifyingUnit: "approved_content_thread",
  fixedComponent: { applicable: true, amountMinor: FIXED_MINOR },
  lfcSfc: { byFormat: { reel: "SFC" } },
});

const G: { partner?: Awaited<ReturnType<FinanceFixtures["seedPartner"]>>; partnerRef: string; refA: string; refB: string; reviewRef: string; detailA?: Awaited<ReturnType<FinanceFixtures["seedActive"]>>; detailB?: Awaited<ReturnType<FinanceFixtures["seedActive"]>>; extraPartnerRefs?: string[] } = { partnerRef: "", refA: "", refB: "", reviewRef: "" };

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
});

test.afterAll(async () => {
  // reviews generated through the UI are unknown to the fixtures by ref: sweep every head of the governed Partner
  for (const partnerRef of [G.partnerRef, ...(G.extraPartnerRefs ?? [])].filter(Boolean)) {
    for (const head of (await partnerReviewsCollection().where("partnerRef", "==", partnerRef).get()).docs) await getAdminFirestore().recursiveDelete(head.ref);
  }
  await pr.cleanupAll();
  await fx.cleanupAll();
});

// ---- text helpers -----------------------------------------------------------------------------------------------------------------------
// The wording Partner Reviews legitimately uses about payment: the payment-AFFECTING evidence label and the warning-only target label.
const ALLOWED_PAYMENT_PHRASES = /Payment-affecting evidence|payment-affecting|does not affect payment|never changes payment-affecting evidence|no money is calculated here/gi;
const MONEY = /₹|\bINR\b|\bUSD\b|\bRs\.?\s?\d|76,?543|7,?654,?321|payable|invoice|currency|\bpayment\b/i;
async function expectNoMoney(page: Page, label: string) {
  const text = (await page.locator("main").innerText()).replace(ALLOWED_PAYMENT_PHRASES, "");
  expect(text, `${label}: money-shaped text on a Partner Reviews page`).not.toMatch(MONEY);
}
const MONEY_KEYS = /"(amountMinor|fixedComponent|currency|paymentCycle|paymentDue\w*|invoice\w*|payable\w*|amount\w*|incentive\w*|advancePayment|accountTransferFee)"\s*:/;
function expectNoMoneyInBodies(bodies: Array<{ url: string; text: string }>) {
  for (const body of bodies) {
    if (!/\/api\/partner-reviews|\/partner-reviews/.test(body.url)) continue;
    expect(body.text, `${body.url}: a money key reached a Partner Reviews response`).not.toMatch(MONEY_KEYS);
    expect(body.text, `${body.url}: the fixed amount reached a Partner Reviews response`).not.toMatch(/7654321|76543\.21|7,654,321/);
  }
}

const kv = (page: Page, label: string) => page.locator(".kv").filter({ has: page.locator("span:first-child", { hasText: new RegExp(`^${label}$`) }) });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const openReview = async (page: Page, query = "") => {
  await page.goto(`/partner-reviews/${G.reviewRef}${query}`);
  await expect(page.locator("h1")).toBeVisible();
  await waitForHydration(page, '[role="tab"]');
};

// =====================================================================================================================
test("SETUP (through the trusted services): a Partner with one in-period Assignment + approved Content + Analytics, and ONE ACTIVE Agreement that carries a required count, an explicit LFC/SFC rule, a warning-only target and a fixed amount", async () => {
  const partner = await fx.seedPartner({ displayName: `${TAG} Governed Partner` });
  G.partner = partner;
  G.partnerRef = partner.partnerRef;
  const assignment = await pr.seedAssignment(partner.partnerRef, { dueAt: `${MONTH}-10`, regionIds: [fx.region] });
  const thread = await pr.seedThread(assignment, { month: MONTH, status: "APPROVED", approvedAt: `${MONTH}-09T00:00:00.000Z`, regionIds: [fx.region] });
  await pr.seedAnalytics(partner.partnerRef, { contentRef: thread.contentRef, likes: 120, views: 4000, month: MONTH, regionIds: [fx.region] });
  const a = await fx.seedActive(fx.partnerCp(partner), GOVERNING_TERMS);
  G.detailA = a;
  G.refA = a.head.agreementRef;
  expect(a.head.status).toBe("ACTIVE");
  G.reviewRef = reviewRefFor(partner.partnerRef, MONTH);
});

test("1a. REAL REGISTRATION: a Head generates the Partner-month Review THROUGH THE UI in the real dev server -> Agreement-governed commercial evidence, and no money anywhere", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const bodies = collectResponseBodies(page);
  await signInAs(page, "head");
  await page.goto(`/partner-reviews/partner/${G.partnerRef}?month=${MONTH}`);
  await expect(page.getByLabel("Reporting month")).toHaveValue(MONTH);
  await waitForHydration(page, '[role="tab"]');
  const generate = page.getByRole("button", { name: "Generate Review" });
  await expect(generate).toBeVisible();
  await generate.click();
  await expect(page.getByRole("link", { name: "Open monthly review" })).toBeVisible();
  await page.getByRole("link", { name: "Open monthly review" }).click();
  await expect(page).toHaveURL(new RegExp(`/partner-reviews/${G.reviewRef}$`));
  await waitForHydration(page, '[role="tab"]');

  // the Agreement-governed evidence (this ONLY happens when the provider is registered in the running server: instrumentation register())
  await expect(page.locator(".detailcontext")).toContainText("Agreement-governed evidence");
  await expect(page.getByText("Monthly commercial evidence")).toBeVisible();
  await expect(kv(page, "Governing Agreement")).toContainText(G.refA);
  await expect(kv(page, "Governing Agreement")).toContainText("version 1");
  await expect(kv(page, "Required qualifying content")).toContainText("2");
  await expect(kv(page, "Actual qualifying content")).toContainText("1");
  await expect(kv(page, "LFC / SFC evidence")).toContainText(/LFC \d+ · SFC \d+ · Unclassified \d+/);
  await expect(page.getByText("Used as commercial evidence")).toBeVisible();
  const targets = page.locator("table").filter({ hasText: "Target value" });
  await expect(targets.locator("tbody tr")).toHaveCount(1);
  await expect(targets.getByText("Target monitoring only · does not affect payment")).toHaveCount(1);
  await expect(targets.getByText("Not met")).toHaveCount(0); // no verified Analytics history for the target -> Unavailable, never Not met
  await expect(page.getByText("Multiple applicable Agreements require resolution")).toHaveCount(0);
  await shot(page, "01-partner-review-commercial-evidence-agreement-governed", true);
  await shotEl(page.locator(".panel", { has: page.getByText("Monthly commercial evidence") }).first(), "01b-commercial-evidence-panel");

  // ... and NO money on ANY Partner Reviews surface
  for (const name of ["Overview", "Production", "Compliance", "Performance", "Version History"]) {
    await tab(page, name).click();
    await expectNoMoney(page, `review detail / ${name}`);
  }
  await page.goto(`/partner-reviews/partner/${G.partnerRef}?month=${MONTH}`);
  await waitForHydration(page, '[role="tab"]');
  for (const name of ["Monthly Trend", "Production", "Compliance", "Performance", "Commercial Evidence", "Review History"]) {
    await tab(page, name).click();
    await expectNoMoney(page, `partner history / ${name}`);
  }
  await tab(page, "Commercial Evidence").click();
  await expect(page.getByText(G.refA).first()).toBeVisible();
  for (const url of [`/partner-reviews/workspace?month=${MONTH}`, "/partner-reviews"]) {
    await page.goto(url);
    await expect(page.locator("h1")).toBeVisible();
    await expectNoMoney(page, url);
  }
  expectNoMoneyInBodies(bodies.bodies);

  // the STORED documents the running server wrote carry no money either (head + version snapshot + events)
  const versionDoc = (await partnerReviewsCollection().doc(G.reviewRef).collection(PARTNER_REVIEWS_COLLECTIONS.versions).doc("1").get()).data()!;
  const stored = JSON.stringify([(await partnerReviewsCollection().doc(G.reviewRef).get()).data(), versionDoc]);
  expect(stored).not.toMatch(MONEY_KEYS);
  expect(stored).not.toMatch(/7654321|76543\.21/);
  expect(versionDoc.snapshot.commercial.governingAgreement).toMatchObject({ agreementRef: G.refA, agreementVersion: 1 });
  expect(versionDoc.snapshot.commercial.monthlyDeliverable.requiredCount).toBe(2);
  expect(versionDoc.snapshot.commercial.targets.every((target: { affectsPayment: boolean }) => target.affectsPayment === false)).toBe(true);
  expect(errors.errors).toEqual([]);
});

test("1b. OVERLAP: a second ACTIVE Agreement for the same Partner-month -> Refresh evidence shows exactly `Multiple applicable Agreements require resolution`; commercial values are unavailable; no crash, no Agreement pick, no reference disclosed", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const bodies = collectResponseBodies(page);
  const b = await fx.seedActive(fx.partnerCp(G.partner!), withTerms({ effectiveDate: "2018-01-01", terminationDate: "2018-12-31", monthlyRequiredQualifyingContentCount: 3, qualifyingUnit: "approved_content_thread", lfcSfc: { byFormat: { reel: "LFC" } } }));
  G.detailB = b;
  G.refB = b.head.agreementRef;

  await signInAs(page, "head");
  await openReview(page);
  // before the refresh the Draft still holds the governed evidence (nothing changes until someone refreshes) ...
  await expect(kv(page, "Governing Agreement")).toContainText(G.refA);
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();

  // ... then it is CONFLICTED: exactly the sentence, values unavailable, nothing picked or merged
  await expect(page.getByText("Multiple applicable Agreements require resolution", { exact: true })).toBeVisible();
  await expect(page.getByText("Multiple applicable Agreements require resolution")).toHaveCount(1);
  await expect(page.getByText(/resolved in the Agreement workflow/)).toBeVisible();
  await expect(kv(page, "Governing Agreement")).toHaveCount(0);
  await expect(kv(page, "Required qualifying content")).toContainText("Unavailable");
  await expect(kv(page, "LFC / SFC evidence")).toContainText("Unavailable");
  await expect(page.locator(".detailcontext")).toContainText("Agreement overlap · commercial evidence unavailable");
  await expect(page.locator(".detailcontext")).not.toContainText("Agreement-governed evidence");
  const text = await page.locator("main").innerText();
  for (const ref of [G.refA, G.refB]) expect(text, "no Agreement reference is disclosed on a conflicted review").not.toContain(ref);
  await expect(page.getByText("Not met")).toHaveCount(0);
  await shot(page, "02-partner-review-agreement-overlap-conflict", true);
  await shotEl(page.locator(".panel", { has: page.getByText("Monthly commercial evidence") }).first(), "02b-conflict-panel");
  await expectNoMoney(page, "conflicted review / Overview");
  for (const name of ["Production", "Compliance", "Performance", "Version History"]) {
    await tab(page, name).click();
    await expectNoMoney(page, `conflicted review / ${name}`);
  }
  await tab(page, "Production").click();
  await expect(page.getByText("Multiple applicable Agreements require resolution")).toHaveCount(1);
  // the stored snapshot records the marker (the refs stay server-side); nothing the ACTOR receives - page, DOM or any response - names an Agreement
  const stored = (await partnerReviewsCollection().doc(G.reviewRef).collection(PARTNER_REVIEWS_COLLECTIONS.versions).doc("1").get()).data()!;
  expect(stored.snapshot.commercial.governingAgreement).toBeNull();
  expect(stored.snapshot.commercial.policyConflict).toEqual({ reason: "multiple_applicable_agreements", agreementRefs: [G.refA, G.refB].sort() });
  expect(await renderedDom(page)).not.toContain(G.refA);
  // (the page document read BEFORE the refresh legitimately named the then-governing Agreement: only what the server sent after the conflict counts)
  const afterConflict = bodies.bodies.filter((body) => /\/refresh$/.test(body.url));
  expect(afterConflict.length, "the refresh response was observed").toBeGreaterThan(0);
  bodies.bodies.length = 0;
  await page.reload();
  await expect(page.getByText("Multiple applicable Agreements require resolution", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  for (const body of [...afterConflict, ...bodies.bodies]) for (const ref of [G.refA, G.refB]) expect(body.text, `${body.url} discloses an Agreement reference of a conflicted review`).not.toContain(ref);
  expect(errors.errors).toEqual([]);
});

test("1c. RESOLUTION belongs to the Agreement workflow: ending one Agreement does not rewrite a month it governed; correcting the other's range does - a refresh then shows the surviving Agreement, and the conflict text is gone", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const head = await fx.actorOf("head");

  // END B (a deliberate Finance lifecycle action): an ENDED Agreement governs only THROUGH its end date, and B was ended long after June 2018 - so the elapsed month stays
  // ambiguous (history is never re-attributed). The review still says so.
  const ended = await endAgreement(head, { agreementRef: G.refB, expectedDocVersion: G.detailB!.head.docVersion, reason: "Ended by the closure certification" }, `e2e-end-${TAG}`);
  if (!ended.ok) throw new Error(`end: ${ended.code}`);
  await signInAs(page, "head");
  await openReview(page);
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();
  await expect(page.getByText("Multiple applicable Agreements require resolution", { exact: true })).toBeVisible();

  // CORRECT the still-ACTIVE Agreement A with a same-start revision whose range ends in February (a deliberate Agreement-workflow act; Partner Reviews never
  // chooses). v1 of A is superseded and governs nothing; June is then governed by B's ENDED version alone (it really was in force in June 2018).
  const latestA = await getAgreementDetail(head, G.refA);
  if (!latestA.ok) throw new Error(`detail: ${latestA.code}`);
  const revised = await createAgreementRevision(head, { agreementRef: G.refA, expectedDocVersion: latestA.data.head.docVersion }, `e2e-rev-${TAG}`);
  if (!revised.ok) throw new Error(`revise: ${revised.code}`);
  const decided = await fx.decideAll(revised.data, [{ fieldKey: "terminationDate", decision: "CORRECTED", value: "2018-02-28" }], "admin");
  const confirmed = await fx.confirm(decided, "admin");
  const latest = await getAgreementDetail(head, G.refA);
  if (!latest.ok) throw new Error(`detail: ${latest.code}`);
  const active = await fx.activate({ ...confirmed, head: latest.data.head }, "head");
  expect(active.head.status).toBe("ACTIVE");

  await openReview(page);
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(page.getByText("Evidence refreshed.")).toBeVisible();
  await expect(page.getByText("Multiple applicable Agreements require resolution")).toHaveCount(0);
  await expect(kv(page, "Governing Agreement")).toContainText(G.refB);
  await expect(kv(page, "Governing Agreement")).toContainText("version 1");
  await expect(kv(page, "Required qualifying content")).toContainText("3");
  await expect(page.locator(".detailcontext")).toContainText("Agreement-governed evidence");
  await shot(page, "03-partner-review-overlap-resolved", true);
  await expectNoMoney(page, "resolved review");
  expect(errors.errors).toEqual([]);
});

// =====================================================================================================================
// 5. DEPENDENCY GUARD through the UI and the API
const blockedText = (kind: "Partner" | "Vendor", state: "an active" | "a suspended", gerund: "archiving" | "blacklisting") => `This ${kind} has ${state} Agreement. End or supersede the Agreement in Finance before ${gerund}.`;

async function confirmLifecycle(page: Page, action: "Archive" | "Blacklist", reasonLabel: RegExp, reason: string) {
  await page.getByRole("button", { name: action, exact: true }).click();
  await page.getByLabel(reasonLabel).fill(reason);
  await page.getByRole("button", { name: "Confirm" }).click();
}

test("5a. PARTNER with an ACTIVE Agreement: Archive and Blacklist are blocked with the plain reason (never auto-ending the Agreement); once the Agreement is ended the Archive succeeds", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const partner = await fx.seedPartner({ displayName: `${TAG} Guarded Partner` });
  const active = await fx.seedActive(fx.partnerCp(partner));
  await page.goto(`/partners/${partner.partnerRef}`);
  await waitForHydration(page, '[role="tab"]');

  await confirmLifecycle(page, "Archive", /Reason for moving to Archived/, "E2E archive attempt while an Agreement is active.");
  await expect(page.getByText("Not ready.")).toBeVisible();
  await expect(page.getByText(blockedText("Partner", "an active", "archiving"))).toBeVisible();
  await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible();
  await shot(page, "04-dependency-guard-partner-archive-blocked");
  await page.getByRole("button", { name: /Cancel/ }).first().click().catch(() => undefined);

  await page.reload();
  await waitForHydration(page, '[role="tab"]');
  await confirmLifecycle(page, "Blacklist", /Reason for moving to Blacklisted/, "E2E blacklist attempt while an Agreement is active.");
  await expect(page.getByText("Not ready.")).toBeVisible();
  await expect(page.getByText(blockedText("Partner", "an active", "blacklisting"))).toBeVisible();
  await shot(page, "05-dependency-guard-partner-blacklist-blocked");

  // the API says the same (a conflict with the reason - nothing changed)
  const partnerDoc = await (await page.request.get(`/api/partners/${partner.partnerRef}`)).json();
  const apiArchive = await page.request.post(`/api/partners/${partner.partnerRef}/archive`, { data: { reason: "E2E API archive attempt.", expectedVersion: partnerDoc.version } });
  expect(apiArchive.status()).toBeGreaterThanOrEqual(400);
  expect(await apiArchive.text()).toContain("active Agreement");
  expect((await (await page.request.get(`/api/partners/${partner.partnerRef}`)).json()).status).toBe("ACTIVE");
  // the Agreement was never touched
  expect((await financeAgreementsCollection().doc(active.head.agreementRef).get()).data()!.status).toBe("ACTIVE");

  // End the Agreement (the deliberate Finance action) -> the block is released
  const ended = await endAgreement(await fx.actorOf("head"), { agreementRef: active.head.agreementRef, expectedDocVersion: active.head.docVersion, reason: "Ended so the Partner can be archived" }, `e2e-end2-${TAG}`);
  if (!ended.ok) throw new Error(`end: ${ended.code}`);
  await page.reload();
  await waitForHydration(page, '[role="tab"]');
  await confirmLifecycle(page, "Archive", /Reason for moving to Archived/, "E2E archive after the Agreement ended.");
  await expect(page.locator(".pill", { hasText: "Archived" })).toBeVisible();
  expect(errors.errors).toEqual([]);
});

test("5b. VENDOR with a SUSPENDED Agreement: Archive is blocked with the plain reason; ending the Agreement releases it", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const vendor = await fx.seedVendor({ displayName: `${TAG} Guarded Vendor` });
  const suspended = await fx.seedSuspended(fx.vendorCp(vendor));
  await page.goto(`/vendors/${vendor.vendorRef}`);
  await waitForHydration(page, '[role="tab"]');
  await confirmLifecycle(page, "Archive", /Reason for archiving/, "E2E archive attempt while an Agreement is suspended.");
  await expect(page.getByText("Not ready.")).toBeVisible();
  await expect(page.getByText(blockedText("Vendor", "a suspended", "archiving"))).toBeVisible();
  await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible();
  await shot(page, "06-dependency-guard-vendor-archive-blocked");
  expect((await financeAgreementsCollection().doc(suspended.head.agreementRef).get()).data()!.status).toBe("SUSPENDED");

  const ended = await endAgreement(await fx.actorOf("head"), { agreementRef: suspended.head.agreementRef, expectedDocVersion: suspended.head.docVersion, reason: "Ended so the Vendor can be archived" }, `e2e-end3-${TAG}`);
  if (!ended.ok) throw new Error(`end: ${ended.code}`);
  await page.reload();
  await waitForHydration(page, '[role="tab"]');
  await confirmLifecycle(page, "Archive", /Reason for archiving/, "E2E archive after the Agreement ended.");
  await expect(page.locator(".pill", { hasText: "Archived" })).toBeVisible();
  expect(errors.errors).toEqual([]);
});

test("5c. INACTIVE is NOT guarded: a Partner and a Vendor with an ACTIVE Agreement can be deactivated and reactivated; the Agreement stays ACTIVE", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const partner = await fx.seedPartner({ displayName: `${TAG} Inactive Partner` });
  const agreement = await fx.seedActive(fx.partnerCp(partner));
  await page.goto(`/partners/${partner.partnerRef}`);
  await waitForHydration(page, '[role="tab"]');
  await page.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.locator(".pill", { hasText: "Inactive" })).toBeVisible();
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible();

  const vendor = await fx.seedVendor({ displayName: `${TAG} Inactive Vendor` });
  const vAgreement = await fx.seedActive(fx.vendorCp(vendor), SUPPORTED_READY_DECISIONS, "admin");
  await page.goto(`/vendors/${vendor.vendorRef}`);
  await waitForHydration(page, '[role="tab"]');
  await page.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.locator(".pill", { hasText: "Inactive" })).toBeVisible();
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible();
  for (const ref of [agreement.head.agreementRef, vAgreement.head.agreementRef]) expect((await financeAgreementsCollection().doc(ref).get()).data()!.status).toBe("ACTIVE");
  expect(errors.errors).toEqual([]);
});

// =====================================================================================================================
// Shared journey helpers (2, 3, 4)
const FAKE_LINK = /^https:\/\/drive\.invalid\/fake\/fake_[0-9a-f]{24}$/;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const SENSITIVE = ["ABCPE1234F", "29ABCPE1234F1Z5", "2341 2341 2346", "234123412346", "123456789012", "HDFC0001234"];
// Everything except what a human decides in the browser: the commercial terms (decided through the trusted service so the browser part stays short).
const COMMERCIAL_SEEDS = SUPPORTED_READY_DECISIONS.filter((seed) => !["counterpartyName", "signedDate", "effectiveDate", "terminationDate"].includes(seed.fieldKey));

const cv = (page: Page) => page.getByTestId("intake-cross_verification");
const rowOf = (page: Page, label: string) => cv(page).locator("tr[data-state]").filter({ has: page.locator("td:first-child b", { hasText: new RegExp(`^${label}$`) }) });
const kycSection = (page: Page) => page.getByTestId("intake-kyc");
const kycRow = (page: Page, component: string) => kycSection(page).locator(`[data-kyc-component="${component}"]`);
const review = (page: Page) => page.getByTestId("intake-review");
const openLinkIn = (scope: Locator) => scope.getByRole("link", { name: /Open Agreement document/ });
const AWAITING = "Confirmed · awaiting activation";

async function pickCounterparty(page: Page, noun: "Partner" | "Vendor", name: string) {
  const box = page.getByRole("combobox", { name: `Search ${noun}` });
  await box.click();
  await box.fill(name);
  const option = page.getByRole("option", { name });
  await expect(option).toBeVisible();
  await option.click();
  await expect(box).toHaveValue(name);
}

// EVERY document of every finance* collection except the ONE restricted extraction store (server-only home of raw extracted values).
async function financeDocuments(): Promise<Array<{ path: string; json: string }>> {
  const out: Array<{ path: string; json: string }> = [];
  const walk = async (ref: FirebaseFirestore.DocumentReference) => {
    const snap = await ref.get();
    if (snap.exists) out.push({ path: ref.path, json: JSON.stringify(snap.data()) });
    for (const sub of await ref.listCollections()) for (const doc of await sub.listDocuments()) await walk(doc);
  };
  for (const root of (await getAdminFirestore().listCollections()).filter((collection) => /^finance/i.test(collection.id) && collection.id !== "financeAgreementRestrictedExtractions")) {
    for (const doc of await root.listDocuments()) await walk(doc);
  }
  return out;
}
async function expectFinanceHoldsNoKyc() {
  const docs = await financeDocuments();
  expect(docs.length, "the Finance walk is not vacuous").toBeGreaterThan(5);
  for (const doc of docs) {
    for (const value of SENSITIVE) expect(doc.json.includes(value), `${doc.path} holds an identity value`).toBe(false);
    expect(doc.json.replace(/"(pan|aadhaar|gst|bank)":"(PRESENT|MISSING|INCOMPLETE|NOT_APPLICABLE)"/g, "").replace(/"\w+":\{"(origin|decision)":/g, "").replace(/"\w+":\{"value":null,/g, ""), `${doc.path}: identity-value key`).not.toMatch(/"(panNumber|aadhaarNumber|accountNumber|accountHolderName|ifsc|gstin|pan|aadhaar|bank)"\s*:/);
  }
}

// From the intake of a NEW / EXISTING draft: decide the commercial terms through the trusted service, accept what extraction proposed, reload.
async function decideRestThroughService(page: Page, agreementRef: string) {
  const admin = await fx.actorOf("admin");
  const detail = await getAgreementDetail(admin, agreementRef);
  if (!detail.ok) throw new Error(`detail: ${detail.code}`);
  await fx.acceptPending(await fx.decideAll(detail.data, COMMERCIAL_SEEDS, "admin"), "admin");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
  await waitForHydration(page, '[data-testid="agreement-intake"] button');
}

// Browser: Review & confirm -> Confirm Agreement -> the original signed file is stored automatically (fake Drive).
async function confirmInBrowser(page: Page, file: { name: string; buffer: Buffer }, agreementRef: string) {
  await expect(review(page).getByTestId("confirm-agreement")).toBeEnabled({ timeout: 30_000 });
  await review(page).getByTestId("confirm-agreement").click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm Agreement" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("Agreement confirmed. Its terms are now frozen.");
  await expect(review(page)).toContainText("Stored. The original signed Agreement is in Drive.", { timeout: 30_000 });
  const version = (await financeAgreementsCollection().doc(agreementRef).collection("versions").doc("1").get()).data()!;
  expect(version.document).toMatchObject({ status: "STORED", fileName: file.name });
  expect(version.document.driveLink).toMatch(FAKE_LINK);
  // the durable reference is tied to the EXACT bytes the person uploaded (no generated substitute)
  expect(version.document.artifactSha256).toBe(sha256(file.buffer));
  return version.document as { driveLink: string; driveFileId: string; fileName: string };
}

// Head activates on the detail page.
async function activateAsHead(page: Page, agreementRef: string) {
  await signInAs(page, "head");
  await page.goto(`/finance/agreements/${agreementRef}`);
  await expect(page.getByRole("tablist", { name: "Agreement sections" })).toBeVisible();
  await waitForHydration(page, '[role="tab"]');
  const activate = page.getByRole("button", { name: "Activate Agreement", exact: true });
  await expect(activate).toBeEnabled();
  await activate.click();
  await page.getByRole("dialog").getByRole("button", { name: "Activate Agreement", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await financeAgreementsCollection().doc(agreementRef).get()).data()?.status, { timeout: 20_000 }).toBe("ACTIVE");
}

// The same stored file reference on every surface: Finance detail (Overview + Versions), the Partner / Vendor contextual panel; Head has the link, Manager none.
async function expectSameDocumentEverywhere(page: Page, options: { agreementRef: string; kind: "PARTNER" | "VENDOR"; ref: string; fileName: string; link: string; lifecycle: string }) {
  const { agreementRef, kind, ref, fileName, link } = options;
  const openContext = async () => {
    if (kind === "PARTNER") {
      await page.goto(`/partners/${ref}`);
      await waitForHydration(page, '[role="tab"]');
      await page.getByRole("tab", { name: "Context" }).click();
    } else {
      await page.goto(`/vendors/${ref}`);
      await waitForHydration(page, '[role="tab"]');
      await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
    }
  };

  // ---- Head: the link exists and is the SAME one everywhere ----
  await signInAs(page, "head");
  await page.goto(`/finance/agreements/${agreementRef}`);
  await expect(page.getByRole("tablist", { name: "Agreement sections" })).toBeVisible();
  const row = page.getByTestId("document-row-1");
  await expect(row).toContainText(fileName);
  await expect(openLinkIn(row)).toHaveAttribute("href", link);
  await page.goto(`/finance/agreements/${agreementRef}?tab=versions`);
  await expect(page.getByTestId("version-document-1")).toContainText(fileName);
  await expect(openLinkIn(page.getByTestId("version-document-1"))).toHaveAttribute("href", link);
  await openContext();
  const list = page.getByTestId("agreement-documents");
  await expect(list).toContainText(fileName);
  await expect(openLinkIn(list)).toHaveAttribute("href", link);
  await expect(list).toContainText(options.lifecycle);
  await expect(list).not.toContainText(/\bDraft\b/);

  // ---- Manager: the file is on record, no link anywhere (page, DOM, or the API) ----
  await signInAs(page, "manager");
  await page.goto(`/finance/agreements/${agreementRef}`);
  await expect(page.getByTestId("document-row-1")).toContainText(fileName);
  await expect(openLinkIn(page.locator("main"))).toHaveCount(0);
  await openContext();
  await expect(page.getByTestId("agreement-documents")).toContainText(fileName);
  await expect(openLinkIn(page.getByTestId("agreement-documents"))).toHaveCount(0);
  expect(await renderedDom(page)).not.toContain("drive.invalid");
  const api = await page.request.get(`/api/finance/agreements/${agreementRef}/document?version=1`);
  expect(await api.text()).not.toContain("drive.invalid");
}

// =====================================================================================================================
// 2. EXISTING-COUNTERPARTY CLOSURE JOURNEY
const X: { partnerRef: string; agreementRef: string; name: string; pdf?: ReturnType<typeof pdfFile>; doc?: { driveLink: string; fileName: string } } = { partnerRef: "", agreementRef: "", name: "" };

test("2. EXISTING PARTNER: select -> master data preloads -> upload + extract -> resolve a mismatch explicitly -> ONLY the missing KYC component offers upload -> confirm -> stored (fake Drive) -> `Confirmed · awaiting activation` (workspace, Partner tile) -> Head activates -> the same document on every surface", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("ex");
  const name = `${TAG} Existing Media`;
  X.name = name;
  const partner = await fx.seedPartner({ displayName: name, email: id.email, phone: id.phoneNormalized });
  X.partnerRef = partner.partnerRef;
  await fx.seedAccount(partner, "instagram", { handle: `${id.handle}_ig`, primary: true });
  await fx.seedKyc(fx.partnerSubject(partner), { aadhaar: true, bank: true, gst: "number", evidence: [] }); // PAN is the ONLY missing component
  const other = uniqueIdentity("excontract");
  const file = pdfFile({ name, email: other.email, phone: id.phone, state: "Kerala", pageLink: `https://www.instagram.com/${id.handle}_ig/` }, "existing-signed.pdf");
  X.pdf = file;

  // ---- select the existing Partner; its master data preloads BEFORE any draft exists ----
  await signInAs(page, "admin");
  await openNewAgreement(page);
  await radio(page, /^Instagram Partner/).click();
  await pickCounterparty(page, "Partner", name);
  await expect(page.getByTestId("intake-existing_details")).toContainText("CreatorOps master data");
  await expect(page.getByTestId("existing-details")).toContainText(name);
  await expect(page.getByTestId("existing-details")).toContainText(id.email);
  await radio(page, /^Account-specific/).click();
  await page.getByTestId("start-draft").click();
  await expect(page).toHaveURL(/agreementRef=agr_[0-9a-f]{20}&version=1/);
  X.agreementRef = new URL(page.url()).searchParams.get("agreementRef")!;
  await waitForHydration(page, 'input[type="file"]');

  // ---- upload + extract + attach (proposals stay PENDING) ----
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByTestId("extract-from-agreement").click();
  await expect(page.getByTestId("extraction-status-chip")).toHaveText(/^(Extracted|Partial)/i);
  await page.getByTestId("attach-extracted").click();
  await expect(page.getByTestId("extraction-attached")).toContainText("Attached as pending");

  // ---- resolve the email MISMATCH explicitly (nothing is decided for the person; the Partner is not written) ----
  const email = rowOf(page, "Email address");
  await expect(email).toHaveAttribute("data-state", "MISMATCH");
  await expect(email.locator("td").nth(1)).toContainText(id.email);
  await expect(email.locator("td").nth(2)).toContainText(other.email);
  await expect(page.getByTestId("confirm-agreement")).toBeDisabled();
  const partnerBefore = JSON.stringify((await getAdminFirestore().collection("partners").doc(partner.uid).get()).data());
  await cv(page).getByRole("button", { name: "Keep CreatorOps value for Email address" }).click();
  await expect(email.locator("td").nth(4)).toContainText(id.email);
  await expect.poll(async () => (await financeAgreementsCollection().doc(X.agreementRef).collection("versions").doc("1").get()).data()!.draft.emailAddress).toMatchObject({ decision: "CORRECTED", value: id.email });
  expect(JSON.stringify((await getAdminFirestore().collection("partners").doc(partner.uid).get()).data())).toBe(partnerBefore);

  // ---- conditional KYC: ONLY the missing component (PAN) offers an action; the complete ones say `KYC available in Partner/Vendor record` and offer none ----
  await expect(kycRow(page, "pan")).toHaveAttribute("data-kind", "missing");
  await expect(kycRow(page, "pan").getByRole("button", { name: /Upload \/ Update/ })).toBeVisible();
  for (const component of ["aadhaar", "bank", "gst"]) {
    await expect(kycRow(page, component)).toHaveAttribute("data-kind", "available");
    await expect(kycRow(page, component).getByRole("button")).toHaveCount(0);
  }
  await expect(kycSection(page).getByRole("button", { name: /Upload \/ Update|Complete bank details/ })).toHaveCount(1);
  await shotEl(kycSection(page), "07-existing-partner-kyc-only-pan-missing");

  // ---- the rest of the fields, then confirm (the original signed file is stored automatically) ----
  await decideRestThroughService(page, X.agreementRef);
  const doc = await confirmInBrowser(page, file, X.agreementRef);
  X.doc = doc;

  // ---- BEFORE activation: `Confirmed · awaiting activation` in the workspace row and on the Partner tile - never a bare "Draft" ----
  await page.goto(`/finance/agreements?q=${encodeURIComponent(name)}`);
  await waitForHydration(page, 'select[aria-label="Filter lifecycle"]');
  const row = page.getByTestId("agreement-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("lifecycle-status")).toHaveText(AWAITING);
  await shot(page, "08-workspace-row-confirmed-awaiting-activation");
  await shotEl(row, "08b-workspace-row-confirmed-awaiting-activation-row");
  await page.goto(`/partners/${partner.partnerRef}`);
  await waitForHydration(page, '[role="tab"]');
  await page.getByRole("tab", { name: "Context" }).click();
  const tile = page.getByTestId("agreement-documents");
  await expect(tile).toContainText(AWAITING);
  await expect(tile).not.toContainText(/\bDraft\b/);
  await shotEl(tile.locator("xpath=ancestor::*[contains(@class,'panel')][1]"), "09-partner-tile-confirmed-awaiting-activation");
  await page.goto(`/finance/agreements/${X.agreementRef}`);
  await expect(page.locator("main").getByText(AWAITING).first()).toBeVisible();

  // ---- Head activates; the same document reference everywhere ----
  await activateAsHead(page, X.agreementRef);
  await expectSameDocumentEverywhere(page, { agreementRef: X.agreementRef, kind: "PARTNER", ref: partner.partnerRef, fileName: "existing-signed.pdf", link: doc.driveLink, lifecycle: "Active" });
  await expectFinanceHoldsNoKyc();
  expect(errors.errors).toEqual([]);
});

// =====================================================================================================================
// 3. NEW PARTNER (Instagram + YouTube) CLOSURE JOURNEY through activation
const createButton = (page: Page) => page.getByTestId("onboarding-create");
const N: { agreementRef: string; partnerRef: string; name: string } = { agreementRef: "", partnerRef: "", name: "" };

async function applyKycFromAgreement(page: Page, fieldLabel: string, kycLabel: string) {
  // the value found in the Agreement is first ACKNOWLEDGED by a person in Cross-verification (a value is never a decision), then applied to the CANONICAL record
  await cv(page).getByRole("button", { name: `Use Agreement value for ${fieldLabel}` }).click();
  await expect(rowOf(page, fieldLabel).locator("td").nth(4)).toContainText("Acknowledged");
  await kycSection(page).getByRole("button", { name: `Upload / Update KYC for ${kycLabel}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("KYC is kept once, in the");
  await dialog.getByRole("button", { name: "Apply from Agreement" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("KYC values from the Agreement were applied");
  await expect(dialog).toHaveCount(0);
}

test("3. NEW PARTNER (Instagram + YouTube): extract preview -> `No strong match found` -> ONE Partner + TWO canonical Accounts via the owning services -> canonical KYC only -> confirm -> stored -> Head activates", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("np");
  const name = `${TAG} New Both Media`;
  N.name = name;
  const file = pdfFile({ name, email: id.email, phone: id.phone, state: "Kerala", pageLink: `https://www.instagram.com/${id.handle}/`, pageName: `${name} Official` }, "new-partner-signed.pdf");

  await signInAs(page, "admin");
  await openWizard(page, "IG_YT_PARTNER");
  await extractInWizard(page, file);
  await page.getByTestId("onboarding-account-youtube").getByLabel(/^YouTube page link/).fill(`https://www.youtube.com/@${id.ytHandle}`);
  await checkDuplicates(page, "Partner");
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("No strong match found");
  await expect(page.getByTestId("onboarding-duplicates-result")).not.toContainText(/no duplicate|no existing/i);
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  N.agreementRef = new URL(page.url()).searchParams.get("agreementRef")!;

  // ONE Partner and TWO canonical Accounts, created through the OWNING services (provenance on their created events)
  const partners = await getAdminFirestore().collection("partners").where("displayName", "==", name).get();
  expect(partners.size).toBe(1);
  const partner = partners.docs[0]!.data();
  N.partnerRef = partner.partnerRef;
  const accounts = (await getAdminFirestore().collection("partnerAccounts").where("partnerRef", "==", partner.partnerRef).get()).docs.map((doc) => doc.data());
  expect(accounts.map((account) => String(account.platform).toLowerCase()).sort()).toEqual(["instagram", "youtube"]);
  const head = (await financeAgreementsCollection().doc(N.agreementRef).get()).data()!;
  expect(head.counterparty.partnerRef).toBe(partner.partnerRef);
  expect([...head.counterparty.partnerAccountRefs].sort()).toEqual(accounts.map((account) => account.partnerAccountRef).sort());

  // the SAME file is re-uploaded, extracted and attached to the new draft (the wizard hand-off)
  await expect(page.getByTestId("cross-verification-contact")).toContainText(id.email, { timeout: 40_000 });
  await waitForHydration(page, '[data-testid="agreement-intake"] button');

  // ---- canonical KYC only: nothing exists yet (all four components missing); apply what the Agreement states to the CANONICAL Partner record ----
  for (const component of ["pan", "aadhaar", "bank", "gst"]) await expect(kycRow(page, component)).toHaveAttribute("data-kind", "missing");
  await applyKycFromAgreement(page, "PAN number", "PAN");
  await applyKycFromAgreement(page, "Aadhaar number", "Aadhaar");
  const identity = restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid));
  await expect.poll(async () => (await identity.get()).data()?.pan?.number ?? null).toBe("ABCPE1234F");
  expect((await identity.get()).data()?.aadhaar?.number).toBe("234123412346");
  await expect(kycRow(page, "pan")).toHaveAttribute("data-kind", "available");
  await expect(kycRow(page, "aadhaar")).toHaveAttribute("data-kind", "available");
  // the browser page carries no full identity value
  expect(await renderedDom(page)).not.toMatch(/ABCPE1234F|234123412346|2341 2341 2346/);
  await shotEl(kycSection(page), "10-new-partner-kyc-after-canonical-apply");

  await decideRestThroughService(page, N.agreementRef);
  const doc = await confirmInBrowser(page, file, N.agreementRef);
  await activateAsHead(page, N.agreementRef);
  await expectSameDocumentEverywhere(page, { agreementRef: N.agreementRef, kind: "PARTNER", ref: partner.partnerRef, fileName: "new-partner-signed.pdf", link: doc.driveLink, lifecycle: "Active" });
  await expectFinanceHoldsNoKyc();
  // still exactly one Partner for the two platforms
  expect((await getAdminFirestore().collection("partners").where("email", "==", id.email).get()).size).toBe(1);
  expect(errors.errors).toEqual([]);
});

// =====================================================================================================================
// 4. NEW VENDOR CLOSURE JOURNEY through activation
test("4. NEW VENDOR: extract preview -> Vendor type required -> canonical Vendor via the owning service -> canonical KYC only (no Aadhaar) -> no represented-Partner link -> confirm -> stored -> Head activates", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("nv");
  const name = `${TAG} New Vendor Works`;
  const file = pdfFile({ name, email: id.email, phone: id.phone, state: "Kerala" }, "new-vendor-signed.pdf");
  const partnersBefore = (await getAdminFirestore().collection("partners").get()).size;

  await signInAs(page, "admin");
  await openWizard(page, "VENDOR");
  await extractInWizard(page, file);
  await page.getByLabel(/^Vendor type/).selectOption("AGENCY");
  await checkDuplicates(page, "Vendor");
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("No strong match found");
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  const agreementRef = new URL(page.url()).searchParams.get("agreementRef")!;

  const vendors = await getAdminFirestore().collection("vendors").where("displayName", "==", name).get();
  expect(vendors.size).toBe(1);
  const vendor = vendors.docs[0]!.data();
  // no represented-Partner link and no Partner / Partner Account created by the Vendor flow
  expect((await getAdminFirestore().collection("vendorPartnerLinks").where("vendorRef", "==", vendor.vendorRef).get()).size).toBe(0);
  expect((await getAdminFirestore().collection("partners").get()).size).toBe(partnersBefore);
  const head = (await financeAgreementsCollection().doc(agreementRef).get()).data()!;
  expect(head.counterparty).toMatchObject({ type: "VENDOR", vendorRef: vendor.vendorRef });

  await expect(page.getByTestId("cross-verification-contact")).toContainText(id.email, { timeout: 40_000 });
  await waitForHydration(page, '[data-testid="agreement-intake"] button');
  // a Vendor has no Aadhaar row; KYC is canonical Vendor KYC only
  await expect(kycRow(page, "aadhaar")).toHaveCount(0);
  await expect(kycRow(page, "pan")).toHaveAttribute("data-kind", "missing");
  await applyKycFromAgreement(page, "PAN number", "PAN");
  const identity = restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("VENDOR", vendor.uid));
  await expect.poll(async () => (await identity.get()).data()?.pan?.number ?? null).toBe("ABCPE1234F");
  expect((await identity.get()).data()).toMatchObject({ subjectType: "VENDOR", aadhaar: null });
  expect(await renderedDom(page)).not.toMatch(/ABCPE1234F/);

  await decideRestThroughService(page, agreementRef);
  const doc = await confirmInBrowser(page, file, agreementRef);
  await activateAsHead(page, agreementRef);
  await expectSameDocumentEverywhere(page, { agreementRef, kind: "VENDOR", ref: vendor.vendorRef, fileName: "new-vendor-signed.pdf", link: doc.driveLink, lifecycle: "Active" });
  await expectFinanceHoldsNoKyc();
  expect((await getAdminFirestore().collection("vendorPartnerLinks").where("vendorRef", "==", vendor.vendorRef).get()).size).toBe(0);
  expect(errors.errors).toEqual([]);
});

// =====================================================================================================================
// RESPONSIVE (1440 / 1200 / 1050 / 760 / 390 / 375, document-level overflow + zero console / page errors) for every surface this step touches:
// the conflicted and the Agreement-governed review, the partner-history commercial tab, the `Confirmed · awaiting activation` workspace row and
// Partner tile, and the dependency-guard blocked message.
test("RESPONSIVE: every surface touched by the closure has no horizontal document overflow and no console errors at 1440 / 1200 / 1050 / 760 / 390 / 375", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const RM = "2018-07";
  // a conflicted Partner-month generated through the UI (the running server has the provider registered)
  const conflicted = await fx.seedPartner({ displayName: `${TAG} Responsive Conflict` });
  const assignment = await pr.seedAssignment(conflicted.partnerRef, { dueAt: `${RM}-10`, regionIds: [fx.region] });
  const thread = await pr.seedThread(assignment, { month: RM, status: "APPROVED", approvedAt: `${RM}-09T00:00:00.000Z`, regionIds: [fx.region] });
  await pr.seedAnalytics(conflicted.partnerRef, { contentRef: thread.contentRef, likes: 10, month: RM, regionIds: [fx.region] });
  await fx.seedActive(fx.partnerCp(conflicted), GOVERNING_TERMS);
  await fx.seedActive(fx.partnerCp(conflicted), GOVERNING_TERMS);
  const guarded = await fx.seedPartner({ displayName: `${TAG} Responsive Guarded` });
  await fx.seedActive(fx.partnerCp(guarded));
  const awaiting = await fx.seedPartner({ displayName: `${TAG} Responsive Awaiting` });
  await fx.seedConfirmed(fx.partnerCp(awaiting));

  await signInAs(page, "head");
  await page.goto(`/partner-reviews/partner/${conflicted.partnerRef}?month=${RM}`);
  await waitForHydration(page, '[role="tab"]');
  await page.getByRole("button", { name: "Generate Review" }).click();
  await page.getByRole("link", { name: "Open monthly review" }).click();
  await page.waitForURL(/\/partner-reviews\/pr_[0-9a-f]{20}$/);
  const conflictedReview = new URL(page.url()).pathname;
  await expect(page.getByText("Multiple applicable Agreements require resolution", { exact: true })).toBeVisible();
  G.extraPartnerRefs = [conflicted.partnerRef];

  const surfaces: Array<{ label: string; open: (p: Page) => Promise<void> }> = [
    { label: "conflicted review", open: async (p) => { await p.goto(conflictedReview); await expect(p.getByText("Multiple applicable Agreements require resolution", { exact: true })).toBeVisible(); } },
    { label: "Agreement-governed review", open: async (p) => { await p.goto(`/partner-reviews/${G.reviewRef}`); await expect(p.getByText("Monthly commercial evidence")).toBeVisible(); } },
    { label: "partner history / Commercial Evidence", open: async (p) => { await p.goto(`/partner-reviews/partner/${G.partnerRef}?month=${MONTH}&tab=commercial`); await expect(p.locator("h1")).toBeVisible(); } },
    { label: "workspace awaiting-activation row", open: async (p) => { await p.goto(`/finance/agreements?q=${encodeURIComponent(`${TAG} Responsive Awaiting`)}`); await expect(p.getByRole("status").filter({ hasText: /Agreements? in this view/ })).toBeVisible(); await expect(p.locator("main")).toContainText(AWAITING); await expect(p.locator("main")).not.toContainText(/\bDraft\b/); } },
    { label: "Partner tile", open: async (p) => { await p.goto(`/partners/${X.partnerRef}`); await waitForHydration(p, '[role="tab"]'); await p.getByRole("tab", { name: "Context" }).click(); await expect(p.getByTestId("agreement-documents")).toBeVisible(); } },
    { label: "dependency-guard blocked message", open: async (p) => { await p.goto(`/partners/${guarded.partnerRef}`); await waitForHydration(p, '[role="tab"]'); await confirmLifecycle(p, "Archive", /Reason for moving to Archived/, "E2E responsive archive attempt."); await expect(p.getByText("Not ready.")).toBeVisible(); } },
  ];
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    for (const surface of surfaces) {
      await surface.open(page);
      const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
      expect(scrollWidth, `${surface.label} overflows the document at ${width}px`).toBeLessThanOrEqual(innerWidth);
      if (width === 390 && surface.label === "conflicted review") await shot(page, "11-conflicted-review-390", true);
      if (width === 390 && surface.label === "workspace awaiting-activation row") await shot(page, "12-workspace-awaiting-activation-390");
      if (width === 375 && surface.label === "dependency-guard blocked message") await shot(page, "13-dependency-guard-blocked-375");
    }
  }
  expect(errors.errors).toEqual([]);
});
