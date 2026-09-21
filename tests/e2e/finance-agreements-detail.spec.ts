import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, collectResponseBodies, createFinanceFixtures, leaked, renderedDom, SENSITIVE_STRINGS, signInAs, SUPPORTED_READY_DECISIONS, waitForHydration, type FinanceFixtures } from "./helpers/finance-agreements-fixtures";
import { financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { partnersCollection } from "@/server/partners/firestore";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default for a UI outcome.
const expect = baseExpect.configure({ timeout: 15_000 });

// Step 14B e2e: the Agreement detail (six tabs), immutable versions, revision, activation, suspend / resume / end, no delete, the
// Activity tab (no sensitive values), the Manager / Head action matrix, neutral not-found and keyboard tab navigation.
// Hermetic private-region fixtures; everything removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `FAD${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);

const REFS: Record<string, string> = {};
const PARTNER_UIDS: Record<string, string> = {};

async function partnerAgreement(key: string, build: (cp: ReturnType<FinanceFixtures["partnerCp"]>) => Promise<{ head: { agreementRef: string } }>, over: Parameters<FinanceFixtures["seedPartner"]>[0] = {}, kyc = false) {
  const partner = await fx.seedPartner({ displayName: `${TAG} ${key}`, ...over });
  const account = await fx.seedAccount(partner, "instagram", { handle: `${key.toLowerCase()}_ig`, primary: true });
  if (kyc) await fx.fullKyc(fx.partnerSubject(partner));
  PARTNER_UIDS[key] = partner.uid;
  REFS[key] = (await build(fx.partnerCp(partner, [account.partnerAccountRef]))).head.agreementRef;
}

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  await partnerAgreement("Immutable", (cp) => fx.seedActive(cp), { email: "orig@example.test" }, true);
  await partnerAgreement("DraftOnly", (cp) => fx.seedDraft(cp));
  await partnerAgreement("Confirmed", (cp) => fx.seedConfirmed(cp));
  await partnerAgreement("Revision", async (cp) => {
    const detail = await fx.seedActiveWithRevision(cp);
    // the revision changes ONE term and one clause
    return fx.decideAll(detail, [
      { fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-06-30" },
      { fieldKey: "paymentDueTerms", decision: "CORRECTED", value: "Payment within 45 days of invoice" },
    ]);
  });
  await partnerAgreement("Lifecycle", (cp) => fx.seedActive(cp));
  await partnerAgreement("Stale", (cp) => fx.seedActive(cp));
  await partnerAgreement("Legacy", (cp) => fx.seedActive(cp, [...SUPPORTED_READY_DECISIONS.filter((seed) => seed.fieldKey !== "qualifyingUnit"), { fieldKey: "qualifyingUnit", decision: "CORRECTED", value: "reel" }]));
  await partnerAgreement("Hidden", (cp) => fx.seedActive(cp, undefined, "admin"), { regionIds: [fx.hiddenRegion] });
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const open = async (page: Page, key: string, query = "") => {
  await page.goto(`/finance/agreements/${REFS[key]}${query}`);
  await expect(page.getByRole("tablist", { name: "Agreement sections" })).toBeVisible();
  await waitForHydration(page, '[role="tab"]');
};
const tab = (page: Page, name: string) => page.getByRole("tab", { name });

test("the detail page: header, context strip and exactly six local tabs (Overview | Terms | Verification | KYC | Versions | Activity), no second sidebar or module tab row", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await open(page, "Immutable");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${TAG} Immutable`);
  await expect(page.locator(".head")).toContainText(REFS.Immutable!);
  const context = page.locator(".detailcontext");
  await expect(context).toContainText("Agreement");
  await expect(context).toContainText("Partner");
  await expect(context).toContainText("Platforms: Instagram");
  await expect(context).toContainText("Active");
  await expect(context).toContainText("Current version 1 of 1");
  await expect(context).toContainText("1 Jan 2024 – 31 Dec 2024");
  await expect(page.getByRole("tab")).toHaveText(["Overview", "Terms", "Verification", "KYC", "Versions", "Activity"]);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  // no second sidebar / module tab row on a detail page
  await expect(page.locator("a.tab")).toHaveCount(0);
  await expect(page.locator("main aside")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(1);
  expect(errors.errors).toEqual([]);
});

test("Overview: counterparty, effective period, commercial summary, KYC readiness, extraction / reconciliation summary and lifecycle actions", async ({ page }) => {
  await open(page, "Immutable");
  const main = page.locator("main");
  for (const heading of ["Agreement summary", "KYC readiness", "Commercial summary", "Source and verification"]) await expect(main.getByRole("heading", { name: heading })).toBeVisible();
  await expect(main).toContainText("1 Jan 2024 – 31 Dec 2024");
  await expect(main).toContainText("₹50,000");
  await expect(main).toContainText("Approved Content");
  await expect(main).toContainText("Fixed + incentive + required content");
  await expect(main).toContainText("Available");
  await expect(main.getByRole("region", { name: "Lifecycle actions" })).toBeVisible();
});

test("Terms: confirmed terms only, payment-affecting terms and warning-only targets in SEPARATE panels; targets say 'Monitoring only · does not affect payment'", async ({ page }) => {
  await open(page, "Immutable", "?tab=terms");
  await expect(tab(page, "Terms")).toHaveAttribute("aria-selected", "true");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Payment-affecting terms" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Performance targets" })).toBeVisible();
  const payment = main.locator(".panel", { has: page.getByRole("heading", { name: "Payment-affecting terms" }) });
  const targets = main.locator(".panel", { has: page.getByRole("heading", { name: "Performance targets" }) });
  await expect(payment).toContainText("₹50,000");
  await expect(payment).not.toContainText("Monitoring only");
  await expect(targets).toContainText("Monitoring only · does not affect payment");
  await expect(targets).not.toContainText("₹50,000");
  await expect(main).not.toContainText("Fixed deliverable units");
  await expect(main).toContainText("Monthly required qualifying content");
});

test("a DRAFT has no confirmed terms to show: Terms says so and Continue draft goes to the intake editor", async ({ page }) => {
  await open(page, "DraftOnly", "?tab=terms");
  await expect(page.getByText(/has no confirmed terms yet/)).toBeVisible();
  await open(page, "DraftOnly");
  await expect(page.getByRole("link", { name: "Continue draft" })).toHaveAttribute("href", `/finance/agreements/new?agreementRef=${REFS.DraftOnly}&version=1`);
});

test("HISTORY IS IMMUTABLE: changing the Partner's master data after activation changes neither the frozen terms nor the frozen provenance - only the live, informational comparison notices", async ({ page }) => {
  await open(page, "Immutable", "?tab=terms");
  const main = page.locator("main");
  await expect(main).toContainText("orig@example.test");
  const version = async () => (await financeAgreementsCollection().doc(REFS.Immutable!).collection("versions").doc("1").get()).data()!;
  const before = JSON.stringify(await version());

  // master data changes AFTER the Agreement was frozen
  await partnersCollection().doc(PARTNER_UIDS.Immutable!).update({ email: "changed@example.test", phone: "+91 91234 56789" });

  await open(page, "Immutable", "?tab=terms");
  await expect(main).toContainText("orig@example.test");
  await expect(main).not.toContainText("changed@example.test");
  expect(JSON.stringify(await version())).toBe(before);

  await open(page, "Immutable", "?tab=verification");
  await expect(main.getByRole("heading", { name: "Frozen at confirmation" })).toBeVisible();
  await expect(main.getByRole("heading", { name: /Comparison with CreatorOps records/ })).toBeVisible();
  // the live comparison notices the difference, and says it never changes the Agreement
  await expect(main.getByText("Live · informational · never changes this Agreement")).toBeVisible();
  await expect(main.getByText("Mismatch").first()).toBeVisible();
  await expect(main).toContainText("orig@example.test");
  // identity values in the live comparison are masked (last four characters) even for the Admin who may compare them
  await expect(main).toContainText("••••••321Z");
  expect(leaked(await renderedDom(page), SENSITIVE_STRINGS)).toEqual([]);
  expect(JSON.stringify(await version())).toBe(before);
});

test("KYC tab: safe statuses by default for a Head; a Manager (no identity category) sees only 'Restricted' statuses - never a value", async ({ page }) => {
  await open(page, "Immutable", "?tab=kyc");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "KYC in the CreatorOps record" })).toBeVisible();
  await expect(main).toContainText("status only");
  expect(leaked(await main.innerText())).toEqual([]);
  await signInAs(page, "manager");
  const bodies = collectResponseBodies(page);
  await open(page, "Immutable", "?tab=kyc");
  await expect(main).toContainText("Restricted");
  expect(leaked(await page.content())).toEqual([]);
  for (const body of bodies.bodies) expect(leaked(body.text), body.url).toEqual([]);
});

test("Activity: only Agreement audit events, newest first, no sensitive value in the page or the events response", async ({ page }) => {
  await signInAs(page, "head");
  const bodies = collectResponseBodies(page);
  await open(page, "Immutable", "?tab=activity");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(main).toContainText(/created|confirmed|activated/i);
  const text = await main.innerText();
  expect(leaked(text)).toEqual([]);
  expect(text).not.toMatch(/example\.test|98765|Bearer|uid|@creatorops/i);
  const events = bodies.bodies.filter((entry) => entry.url.includes("/events"));
  expect(events.length).toBeGreaterThan(0);
  for (const entry of events) expect(leaked(entry.text)).toEqual([]);
});

test("Versions: an immutable list (number, status, effective dates, confirmed / activated by and time, source mode, current) - selecting one shows it read-only", async ({ page }) => {
  await open(page, "Revision", "?tab=versions");
  const main = page.locator("main");
  const v1 = main.getByTestId("version-row-1");
  const v2 = main.getByTestId("version-row-2");
  await expect(v1).toContainText("Active");
  await expect(v1).toContainText("1 Jan 2024 – 31 Dec 2024");
  await expect(v1).toContainText("Manual");
  await expect(v2).toContainText("Draft");
  // the version in force is the one being viewed; the open draft can be selected (read-only) and the page follows
  await expect(v1).toContainText("Viewing");
  await v2.getByRole("button", { name: "View version 2" }).click();
  await expect(tab(page, "Terms")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=terms&version=2|version=2&tab=terms/);
  await expect(page.getByText(/has no confirmed terms yet/)).toBeVisible();
  await tab(page, "Versions").click();
  await expect(v2).toContainText("Viewing");
  await v1.getByRole("button", { name: "View version 1" }).click();
  await expect(page.getByText(/Payment within 30 days of invoice/)).toBeVisible();
});

test("Revision: an ACTIVE Agreement with an open revision keeps its version in force, shows the changed fields against it, and the intake editor marks each changed field", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, "Revision");
  const main = page.locator("main");
  await expect(page.locator(".detailcontext")).toContainText("Current version 1 of 2");
  await expect(page.locator(".detailcontext")).toContainText("draft version 2 open");
  await expect(main.getByRole("heading", { name: "Draft version 2" })).toBeVisible();
  // no second revision can be created while one is open
  await expect(page.getByRole("button", { name: "Create revision", exact: true })).toHaveCount(0);
  const toEditor = page.getByRole("link", { name: "Continue draft" });
  await expect(toEditor).toHaveAttribute("href", `/finance/agreements/new?agreementRef=${REFS.Revision}&version=2`);
  await toEditor.click();
  await expect(page.getByRole("heading", { level: 1, name: "Agreement revision" })).toBeVisible();
  const changes = page.getByTestId("revision-changes");
  await expect(changes).toContainText("Changes from version 1");
  await expect(changes).toContainText("Termination date");
  await expect(changes).toContainText("Payment due terms");
  await expect(page.locator('[data-field-row="terminationDate"]').getByText("Changed from previous version")).toBeVisible();
  await expect(page.locator('[data-field-row="terminationDate"]')).toContainText("Previous version: 31 Dec 2024");
  await expect(page.locator('[data-field-row="currency"]').getByText("Changed from previous version")).toHaveCount(0);
});

test("activation of a confirmed revision SUPERSEDES the earlier version, which stays readable exactly as it was", async ({ page }) => {
  // the Manager prepares + confirms the revision (through the trusted service), the Head activates it in the browser
  const detail = await (await import("@/server/finance-agreements")).getAgreementDetail(await fx.actorOf("head"), REFS.Revision!, { version: 2 });
  if (!detail.ok) throw new Error("no detail");
  const v1Before = JSON.stringify((await financeAgreementsCollection().doc(REFS.Revision!).collection("versions").doc("1").get()).data());
  await fx.confirm(await fx.acceptPending(detail.data));

  await signInAs(page, "head");
  await open(page, "Revision");
  await page.getByRole("button", { name: "Activate Agreement", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Activate this version?");
  await dialog.getByRole("button", { name: "Activate Agreement", exact: true }).click();
  await expect(page.getByText("Version 2 is now the version in force.")).toBeVisible();
  await expect(page.locator(".detailcontext")).toContainText("Current version 2 of 2");
  await tab(page, "Versions").click();
  await expect(page.getByTestId("version-row-1")).toContainText("Superseded");
  await expect(page.getByTestId("version-row-2")).toContainText("Active");
  expect(JSON.stringify((await financeAgreementsCollection().doc(REFS.Revision!).collection("versions").doc("1").get()).data())).not.toBe(v1Before);
  // ^ only the lifecycle pointers of v1 moved (status SUPERSEDED); its frozen terms are byte-identical
  const v1 = (await financeAgreementsCollection().doc(REFS.Revision!).collection("versions").doc("1").get()).data()!;
  expect(v1.status).toBe("SUPERSEDED");
  expect(JSON.parse(v1Before).terms).toEqual(v1.terms);
  await page.getByTestId("version-row-1").getByRole("button", { name: "View version 1" }).click();
  await expect(page.getByText(/is an earlier version and is read only/)).toBeVisible();
  await expect(page.locator("main")).toContainText("31 Dec 2024");
});

test("lifecycle dialogs: Suspend needs a reason, Resume, End (permanent, reason) - each is a confirmation dialog; ENDED versions stay readable and a new revision may follow", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, "Lifecycle");
  // Suspend: reason required (at least 3 characters)
  await page.getByRole("button", { name: "Suspend Agreement", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Suspend this Agreement?");
  const submit = dialog.getByRole("button", { name: "Suspend Agreement", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/Reason/).fill("ab");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(/Reason/).fill("Paused while the brand renegotiates");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText("Agreement suspended.")).toBeVisible();
  await expect(page.locator(".detailcontext")).toContainText("Suspended");
  await expect(page.getByRole("button", { name: "Suspend Agreement", exact: true })).toHaveCount(0);

  // Resume
  await page.getByRole("button", { name: "Resume Agreement", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Resume this Agreement?");
  await dialog.getByRole("button", { name: "Resume Agreement", exact: true }).click();
  await expect(page.getByText("Agreement resumed.")).toBeVisible();
  await expect(page.locator(".detailcontext")).toContainText("Active");

  // End: permanent, reason required; Escape cancels without change
  await page.getByRole("button", { name: "End Agreement", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Ending is permanent");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".detailcontext")).toContainText("Active");
  await page.getByRole("button", { name: "End Agreement", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("Relationship concluded by mutual agreement");
  await dialog.getByRole("button", { name: "End Agreement", exact: true }).click();
  await expect(page.getByText("Agreement ended. Its versions stay readable.")).toBeVisible();
  await expect(page.locator(".detailcontext")).toContainText("Ended");
  await expect(page.getByRole("button", { name: /^(Suspend|Resume|End) Agreement$/ })).toHaveCount(0);
  await tab(page, "Terms").click();
  await expect(page.locator("main")).toContainText("₹50,000");
  await expect(page.getByRole("button", { name: "Create revision", exact: true })).toBeVisible();
  const head = (await financeAgreementsCollection().doc(REFS.Lifecycle!).get()).data()!;
  expect(head.status).toBe("ENDED");
});

test("Create revision (Head): confirmation dialog creates the next DRAFT prefilled from the frozen terms and continues into the intake editor; the version in force is unchanged", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, "Legacy");
  await page.getByRole("button", { name: "Create revision", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Create a revision?");
  await dialog.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/finance/agreements/new\\?agreementRef=${REFS.Legacy}&version=2`));
  await expect(page.getByRole("heading", { level: 1, name: "Agreement revision" })).toBeVisible();
  // the frozen version-1 terms are prefilled: a legacy unit is shown as written, needing mapping - never silently mapped
  await expect(page.locator('[data-field-row="qualifyingUnit"]')).toContainText("Needs mapping");
  const head = (await financeAgreementsCollection().doc(REFS.Legacy!).get()).data()!;
  expect(head).toMatchObject({ status: "ACTIVE", activeVersion: 1, openVersion: 2 });
});

test("a Manager sees the Agreement but NO Activate / Create revision / Suspend / End; a confirmed draft shows the waiting note instead", async ({ page }) => {
  await signInAs(page, "manager");
  await open(page, "Lifecycle");
  await expect(page.getByRole("button", { name: /^(Activate Agreement|Create revision|Suspend Agreement|End Agreement|Resume Agreement)$/ })).toHaveCount(0);
  await open(page, "Immutable");
  await expect(page.getByRole("button", { name: /^(Activate Agreement|Create revision|Suspend Agreement|End Agreement)$/ })).toHaveCount(0);
  await open(page, "Confirmed");
  await expect(page.getByRole("button", { name: "Activate Agreement", exact: true })).toHaveCount(0);
  await expect(page.getByText(/waiting to be activated by someone with activation permission/)).toBeVisible();
  // ...and a Head sees Activate on that same confirmed version
  await signInAs(page, "head");
  await open(page, "Confirmed");
  await expect(page.getByRole("button", { name: "Activate Agreement", exact: true })).toBeVisible();
  // a Manager DOES get Confirm / Continue draft on an unconfirmed draft
  await signInAs(page, "manager");
  await open(page, "DraftOnly");
  await expect(page.getByRole("link", { name: "Continue draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm Agreement", exact: true })).toBeVisible();
});

test("there is NO delete anywhere: no control on any tab, and the API has no DELETE", async ({ page }) => {
  await signInAs(page, "head");
  for (const name of ["overview", "terms", "verification", "kyc", "versions", "activity"]) {
    await open(page, "Immutable", name === "overview" ? "" : `?tab=${name}`);
    await expect(page.getByRole("button", { name: /delete|remove agreement|discard agreement/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /delete/i })).toHaveCount(0);
  }
  const response = await page.request.delete(`/api/finance/agreements/${REFS.Immutable}`);
  expect([404, 405]).toContain(response.status());
  expect((await financeAgreementsCollection().doc(REFS.Immutable!).get()).exists).toBe(true);
});

test("tabs are keyboard operable (ArrowRight / ArrowLeft / Home / End), the selected tab is in the URL, and a reload restores it", async ({ page }) => {
  await open(page, "Immutable");
  await tab(page, "Overview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Terms")).toBeFocused();
  await expect(tab(page, "Terms")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=terms/);
  await page.keyboard.press("End");
  await expect(tab(page, "Activity")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await page.goto(`/finance/agreements/${REFS.Immutable}?tab=versions`);
  await expect(tab(page, "Versions")).toHaveAttribute("aria-selected", "true");
  await page.goto(`/finance/agreements/${REFS.Immutable}?tab=bogus`);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
});

test("neutral errors: a forged ref and an out-of-scope Agreement look identical (one not-found), a Viewer is redirected before anything renders", async ({ page }) => {
  await signInAs(page, "manager");
  await page.goto("/finance/agreements/agr_00000000000000000000");
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  const forgedText = await page.locator("body").innerText();
  await page.goto(`/finance/agreements/${REFS.Hidden}`);
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  expect(await page.locator("body").innerText()).toBe(forgedText);
  expect(await page.locator("body").innerText()).not.toContain(`${TAG} Hidden`);
  const api = await page.request.get(`/api/finance/agreements/${REFS.Hidden}`);
  expect(api.status()).toBe(404);
  expect(await api.json()).toEqual({ error: "Not found." });
  // an admin (global scope) does see it
  await signInAs(page, "admin");
  await open(page, "Hidden");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hidden");
});

test("a stale write is a banner with Reload latest - never a silent overwrite", async ({ page }) => {
  await signInAs(page, "head");
  await open(page, "Stale");
  // another operator suspends it between this page's load and the click
  const service = await import("@/server/finance-agreements");
  const head = await fx.actorOf("head");
  const detail = await service.getAgreementDetail(head, REFS.Stale!, {});
  if (!detail.ok) throw new Error("no detail");
  const suspended = await service.suspendAgreement(head, { agreementRef: REFS.Stale!, expectedDocVersion: detail.data.head.docVersion, reason: "Suspended elsewhere" }, "e2e-stale");
  expect(suspended.ok).toBe(true);
  await page.getByRole("button", { name: "End Agreement", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("Ending from a stale page");
  await dialog.getByRole("button", { name: "End Agreement", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /changed elsewhere/i })).toBeVisible();
  // nothing was overwritten: the Agreement is still the other operator's SUSPENDED state
  expect((await financeAgreementsCollection().doc(REFS.Stale!).get()).data()!.status).toBe("SUSPENDED");
  await page.getByRole("button", { name: "Reload latest" }).click();
  await expect(page.getByText("Reloaded the latest version of this Agreement.")).toBeVisible();
  await expect(page.locator(".detailcontext")).toContainText("Suspended");
});
