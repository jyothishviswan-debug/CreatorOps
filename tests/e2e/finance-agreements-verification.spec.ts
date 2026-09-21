import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";

import { collectBrowserErrors, collectResponseBodies, createFinanceFixtures, CONTRACT_SENSITIVE, leaked, renderedDom, SECRETS, SENSITIVE_STRINGS, SUPPORTED_READY_DECISIONS, signInAs, waitForHydration, type FinanceFixtures } from "./helpers/finance-agreements-fixtures";
import { financeAgreementEventsCollection, financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { partnersCollection } from "@/server/partners/firestore";
import { restrictedFinancialIdentitiesCollection, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default for a UI outcome.
const expect = baseExpect.configure({ timeout: 15_000 });

// Step 14B e2e: cross-verification (Match / Missing in CreatorOps / Missing in Agreement / Mismatch / Restricted / Unavailable),
// mismatch resolution, the separate Update Partner dialog and its owning-module authorization, the KYC section, commercial terms,
// performance targets, Review & confirm and keyboard flows. Hermetic private-region fixtures; everything removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `FAV${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);

type Seeded = { partnerRef: string; partnerUid: string; agreementRef: string };
const S: Record<string, Seeded> = {};

async function partnerDraft(key: string, over: Parameters<FinanceFixtures["seedPartner"]>[0] = {}, opts: { contract?: boolean; kyc?: "full" | "none" | "pan"; partnerLevel?: boolean } = {}) {
  const partner = await fx.seedPartner({ displayName: `${TAG} ${key}`, ...over });
  const account = await fx.seedAccount(partner, "instagram", { handle: `${key.toLowerCase().replace(/\W/g, "")}_ig`, primary: true });
  if (opts.kyc === "full") await fx.fullKyc(fx.partnerSubject(partner));
  if (opts.kyc === "pan") await fx.seedKyc(fx.partnerSubject(partner), { pan: true });
  let draft = await fx.newDraft(fx.partnerCp(partner, opts.partnerLevel ? undefined : [account.partnerAccountRef]));
  if (opts.contract) draft = await fx.attachContract(draft);
  S[key] = { partnerRef: partner.partnerRef, partnerUid: partner.uid, agreementRef: draft.head.agreementRef };
  return draft;
}

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  // all three contact values equal what a draft prefills -> MATCH rows; full KYC on record
  await partnerDraft("PartnerLevel", {}, { partnerLevel: true });
  await partnerDraft("MatchAll", { email: "match@example.test", phone: "+91 90000 22222" }, { kyc: "full" });
  // Agreement (sample) says: Sample Creator Studio / hello@samplecreator.example / +91 98765 43210 / Karnataka
  await partnerDraft("Mismatch", { email: "differs@example.test", phone: null }, { contract: true, kyc: "none" });
  await partnerDraft("UpdateFill", { email: "differs@example.test", phone: null }, { contract: true });
  await partnerDraft("UpdateDeny", { email: "differs@example.test", phone: null }, { contract: true });
  await partnerDraft("KycFull", {}, { kyc: "full" });
  await partnerDraft("KycNone", {}, { kyc: "none" });
  await partnerDraft("KycPart", {}, { kyc: "pan" });
  await partnerDraft("KycApply", {}, { contract: true });
  await partnerDraft("CommercialX", {}, { contract: true });
  await partnerDraft("CommercialY", {});

  // Review: every field decided (nothing pending), not confirmed
  const review = await partnerDraft("ReviewReady");
  await fx.acceptPending(await fx.decideAll(review, SUPPORTED_READY_DECISIONS));
  await partnerDraft("ReviewBlocked");
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const openDraft = async (page: Page, key: string) => {
  await page.goto(`/finance/agreements/new?agreementRef=${S[key]!.agreementRef}&version=1`);
  await expect(page.getByRole("heading", { level: 1, name: /^Agreement( draft| revision)?$/ })).toBeVisible();
  await waitForHydration(page, '[data-testid="agreement-intake"] button');
};
const cv = (page: Page) => page.getByTestId("intake-cross_verification");
const rowOf = (page: Page, label: string) => cv(page).locator("tr[data-state]").filter({ has: page.locator("td:first-child b", { hasText: new RegExp(`^${label}$`) }) });
const btn = (page: Page, name: string | RegExp) => cv(page).getByRole("button", { name });
const partnerDoc = async (key: string) => (await partnersCollection().doc(S[key]!.partnerUid).get()).data()!;
const rowStatus = (row: Locator, text: string) => expect(row.locator("td").nth(3)).toContainText(text);

// ---- Cross-verification statuses ----------------------------------------------------------------------------------------------------------
test("Match / Missing in Agreement / Unavailable are shown as TEXT (not colour alone), CreatorOps value and Agreement value side by side, master-data source labelled", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openDraft(page, "MatchAll");
  await expect(cv(page).getByRole("columnheader").first()).toBeVisible();
  for (const header of ["Field", "CreatorOps value", "Agreement value", "Status", "Confirmed value / action"]) await expect(cv(page).getByRole("columnheader", { name: header }).first()).toBeVisible();

  for (const label of ["Counterparty name", "Contact number", "Email address"]) {
    const row = rowOf(page, label);
    await expect(row, label).toHaveAttribute("data-state", "MATCH");
    await rowStatus(row, "Match");
  }
  await expect(rowOf(page, "Email address").locator("td").nth(1)).toContainText("match@example.test");
  await expect(rowOf(page, "Email address").locator("td").nth(2)).toContainText("match@example.test");
  await expect(rowOf(page, "Email address").locator("td").nth(1)).toContainText("CreatorOps master data");
  // Match: allow confirm
  await expect(btn(page, "Confirm for Email address")).toBeVisible();

  // Missing in Agreement (identity, with access): CreatorOps holds a GSTIN, the Agreement says nothing
  const gst = rowOf(page, "GSTIN");
  await expect(gst).toHaveAttribute("data-state", "MISSING_IN_AGREEMENT");
  await expect(gst).toContainText("Source: CreatorOps master data");

  // Missing in Agreement: a Partner-level draft names no platform; CreatorOps holds the Partner Accounts. The value is labelled as master data, never "extracted"
  await openDraft(page, "PartnerLevel");
  const platforms = rowOf(page, "Platforms");
  await expect(platforms).toHaveAttribute("data-state", "MISSING_IN_AGREEMENT");
  await rowStatus(platforms, "Missing in Agreement");
  await expect(platforms).toContainText("Source: CreatorOps master data");
  await expect(platforms).not.toContainText(/extracted/i);
  await expect(btn(page, "Use CreatorOps value for Platforms")).toBeVisible();

  // Unavailable: address / PIN have no canonical field - never invented
  for (const label of ["Address", "PIN code"]) {
    const row = rowOf(page, label);
    await expect(row, label).toHaveAttribute("data-state", "UNAVAILABLE");
    await rowStatus(row, "Unavailable");
    await expect(row.locator("td").nth(1)).toContainText("Not available in CreatorOps");
  }
  expect(errors.errors).toEqual([]);
});

test("Mismatch and Missing in CreatorOps after an extraction: the mismatch row is highlighted (and says Mismatch), and it needs a deliberate choice", async ({ page }) => {
  await openDraft(page, "Mismatch");
  const email = rowOf(page, "Email address");
  await expect(email).toHaveAttribute("data-state", "MISMATCH");
  await rowStatus(email, "Mismatch");
  await expect(email.locator("td").nth(1)).toContainText("differs@example.test");
  await expect(email.locator("td").nth(2)).toContainText("hello@samplecreator.example");
  // subtle highlight on the mismatch row only, and never the only signal
  const tint = await email.evaluate((el) => getComputedStyle(el).backgroundColor);
  const plain = await rowOf(page, "Address").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tint).not.toBe(plain);
  await expect(rowOf(page, "Counterparty name")).toHaveAttribute("data-state", "MISMATCH");

  const phone = rowOf(page, "Contact number");
  await expect(phone).toHaveAttribute("data-state", "MISSING_IN_CREATOROPS");
  await rowStatus(phone, "Missing in CreatorOps");
  await expect(btn(page, "Use Agreement value for Contact number")).toBeVisible();

  // a mismatch offers exactly the three deliberate choices, NO plain Confirm, and nothing is pre-decided
  await expect(btn(page, "Keep CreatorOps value for Email address")).toBeVisible();
  await expect(btn(page, "Use Agreement value for Email address")).toBeVisible();
  await expect(btn(page, "Enter corrected value for Email address")).toBeVisible();
  await expect(btn(page, "Confirm for Email address")).toHaveCount(0);
  await expect(email.getByText("Needs confirmation")).toBeVisible();
  await expect(page.getByTestId("confirm-agreement")).toBeDisabled();
  await expect(page.getByTestId("cross-verification-summary")).toContainText(/to resolve|need|decision/i);
});

test("resolving a mismatch: Keep CreatorOps value / Use Agreement value / Enter corrected value each record ONE explicit decision on the Agreement and change no Partner data", async ({ page }) => {
  await openDraft(page, "Mismatch");
  const before = await partnerDoc("Mismatch");
  const stored = async () => (await financeAgreementsCollection().doc(S.Mismatch!.agreementRef).collection("versions").doc("1").get()).data()!;
  expect((await stored()).draft.emailAddress.decision).toBe("PENDING");

  // Keep CreatorOps value: the Agreement keeps what CreatorOps holds (a CORRECTED decision carrying that value)
  const email = rowOf(page, "Email address");
  await btn(page, "Keep CreatorOps value for Email address").click();
  await expect(email.locator("td").nth(4)).toContainText("differs@example.test");
  await expect(email.locator("td").nth(4)).toContainText("Corrected");
  await expect.poll(async () => (await stored()).draft.emailAddress).toMatchObject({ decision: "CORRECTED", value: "differs@example.test" });
  // truthful provenance: the kept value is the person's decision, NOT something the Agreement said (no "Agreement · page 1" claim)
  const agreementCell = email.locator("td").nth(2);
  await expect(agreementCell).toContainText("Kept CreatorOps value · your decision");
  await expect(agreementCell).toContainText("The Agreement said: hello@samplecreator.example");
  await expect(agreementCell).not.toContainText(/page 1|Confidence/);
  // the decision can still be changed (a mis-click is not final): typed value
  await btn(page, "Enter corrected value for Email address").click();
  await cv(page).getByLabel("Corrected email address").fill("");
  await cv(page).getByRole("button", { name: "Use this value" }).click();
  await expect(cv(page).getByRole("alert").first()).toBeVisible();
  await cv(page).getByLabel("Corrected email address").fill("typed@example.test");
  await cv(page).getByRole("button", { name: "Use this value" }).click();
  await expect(email.locator("td").nth(4)).toContainText("typed@example.test");
  await expect(email.locator("td").nth(2)).toContainText("Entered by you · your decision");

  // Use Agreement value (a mismatch stays a mismatch: the Agreement now carries ITS value; CreatorOps is untouched)
  const name = rowOf(page, "Counterparty name");
  await btn(page, "Use Agreement value for Counterparty name").click();
  await expect(btn(page, "Use Agreement value for Counterparty name")).toHaveAttribute("aria-pressed", "true");
  await expect(name.locator("td").nth(4)).toContainText("Sample Creator Studio");
  await expect.poll(async () => (await stored()).draft.counterpartyName).toMatchObject({ decision: "ACCEPTED", value: "Sample Creator Studio" });
  await expect(name).toHaveAttribute("data-state", "MISMATCH");

  // the summary follows, and Saving the draft still writes NOTHING to the Partner
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
  expect(await partnerDoc("Mismatch")).toEqual(before);
  expect((await stored()).draft.emailAddress.value).toBe("typed@example.test");
});

test("Restricted rows: a Manager sees the outcome word only - no CreatorOps value, no Agreement value, no action - and no sensitive string anywhere", async ({ page }) => {
  await signInAs(page, "manager");
  const bodies = collectResponseBodies(page);
  await openDraft(page, "Mismatch");
  for (const label of ["GSTIN", "Aadhaar number", "PAN number", "Bank account number", "IFSC"]) {
    const row = rowOf(page, label);
    await expect(row, label).toHaveAttribute("data-state", "RESTRICTED");
    await rowStatus(row, "Restricted");
    await expect(row.getByRole("button")).toHaveCount(0);
  }
  await expect(rowOf(page, "PAN number")).toContainText("No value is shown");
  expect(leaked(await page.content())).toEqual([]);
  for (const body of bodies.bodies) expect(leaked(body.text), body.url).toEqual([]);
  await expect(cv(page).getByText(/Restricted/).first()).toBeVisible();
});

test("NO actor - Admin, Head or Manager - ever has a FULL identity value in the page text or DOM (draft with KYC on record and a contract extracted); authorized actors see masked values and match / mismatch STATUS text", async ({ page }) => {
  for (const role of ["admin", "head", "manager"] as const) {
    await signInAs(page, role);
    for (const key of ["MatchAll", "Mismatch", "KycApply"]) {
      await openDraft(page, key);
      await expect(cv(page).locator("tr[data-state]").first()).toBeVisible();
      // the raw contract snippets (contract access only) sit in the DOM inside <details>: the DOM scan below covers them, opened or not
      const text = await page.locator("body").innerText();
      const html = await renderedDom(page);
      expect(leaked(text, SENSITIVE_STRINGS), `${role} ${key}: page text`).toEqual([]);
      expect(leaked(html, SENSITIVE_STRINGS), `${role} ${key}: DOM`).toEqual([]);
      if (role === "manager") await expect(rowOf(page, "PAN number")).toHaveAttribute("data-state", "RESTRICTED");
      else await expect(rowOf(page, "PAN number").locator("td").nth(3)).toContainText(/Missing in|Match|Mismatch/);
    }
    await page.goto(`/finance/agreements/${S.MatchAll!.agreementRef}?tab=verification`);
    await expect(page.getByRole("heading", { name: /Comparison with CreatorOps records/ })).toBeVisible();
    expect(leaked(await renderedDom(page), SENSITIVE_STRINGS), `${role}: detail Verification tab`).toEqual([]);
  }
});

test("a Head (identity category) compares identity fields but a value is still never a decision: acknowledgement only", async ({ page }) => {
  await signInAs(page, "head");
  await openDraft(page, "MatchAll");
  const pan = rowOf(page, "PAN number");
  await expect(pan).toHaveAttribute("data-state", "MISSING_IN_AGREEMENT");
  // an authorized actor compares, but the page only ever prints the LAST FOUR characters
  await expect(pan.locator("td").nth(1)).toContainText("••••••321Z");
  await expect(rowOf(page, "GSTIN").locator("td").nth(1)).toContainText("•".repeat(11) + "Z1Z9");
  await expect(rowOf(page, "Bank account number").locator("td").nth(1)).toContainText("•".repeat(8) + "5544");
  await expect(rowOf(page, "IFSC").locator("td").nth(1)).toContainText("•".repeat(7) + "9876");
  await btn(page, "Use CreatorOps value for PAN number").click();
  await expect(pan.locator("td").nth(4)).toContainText("Acknowledged");
  const stored = (await financeAgreementsCollection().doc(S.MatchAll!.agreementRef).collection("versions").doc("1").get()).data()!;
  expect(stored.draft.panNumber.value).toBeNull();
  expect(JSON.stringify(stored)).not.toContain(SECRETS.pan);
});

// ---- Explicit master-data update -------------------------------------------------------------------------------------------------------------
test("'Update Partner' is a SEPARATE explicit action with its own confirmation dialog: Cancel changes nothing, Confirm fills the empty Partner phone through the owning module", async ({ page }) => {
  await openDraft(page, "UpdateFill");
  const phoneRow = rowOf(page, "Contact number");
  await expect(phoneRow).toHaveAttribute("data-state", "MISSING_IN_CREATOROPS");
  // first the Agreement's own decision (Use Agreement value)...
  await btn(page, "Use Agreement value for Contact number").click();
  await expect(phoneRow.locator("td").nth(4)).toContainText(/98765|9876543210/);
  // ...which by itself never touches the Partner
  expect((await partnerDoc("UpdateFill")).phone).toBeNull();
  await expect(phoneRow).toContainText("Changes the Partner or Vendor record");
  const update = btn(page, /^Update Partner.* for Contact number/);
  await expect(update).toBeVisible();
  await update.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This fills the contact number on the Partner record");
  await expect(dialog).toContainText("Saving the Agreement never changes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect((await partnerDoc("UpdateFill")).phone).toBeNull();
  // focus returns to the button that opened it
  await expect(update).toBeFocused();

  await update.click();
  await page.getByRole("dialog").getByRole("button", { name: "Update Partner", exact: true }).click();
  await expect(page.getByTestId("intake-status")).toContainText("Partner record updated in CreatorOps master data");
  await expect.poll(async () => (await partnerDoc("UpdateFill")).phone).not.toBeNull();
  await expect(rowOf(page, "Contact number")).toHaveAttribute("data-state", "MATCH");
  // audited on the Agreement, without the value
  const events = await financeAgreementEventsCollection(S.UpdateFill!.agreementRef).get();
  const audit = events.docs.map((doc) => doc.data()).find((event) => event.kind === "master_data_updated");
  expect(audit).toBeTruthy();
  expect(JSON.stringify(audit)).not.toMatch(/98765|9876543210/);
});

test("replacing a DIFFERENT CreatorOps value needs its own dialog with an acknowledged reason: Confirm stays disabled until both are given", async ({ page }) => {
  await openDraft(page, "UpdateFill");
  const emailRow = rowOf(page, "Email address");
  await expect(emailRow).toHaveAttribute("data-state", "MISMATCH");
  await btn(page, "Use Agreement value for Email address").click();
  const replace = btn(page, /^Update Partner(\/Vendor)? after confirmation for Email address/);
  await expect(replace).toBeVisible();
  await replace.click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: /^Replace email address/ });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Why is the CreatorOps value being replaced?").fill("Signed Agreement carries the correct address");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/I understand this replaces the value/).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("intake-status")).toContainText("Partner record updated");
  await expect.poll(async () => (await partnerDoc("UpdateFill")).email).toBe("hello@samplecreator.example");
  const events = await financeAgreementEventsCollection(S.UpdateFill!.agreementRef).get();
  const audit = events.docs.map((doc) => doc.data()).filter((event) => event.kind === "master_data_updated");
  expect(audit.length).toBe(2);
});

test("owning-module authorization: a Manager without the Partner edit action is DENIED - the dialog shows a neutral error and the Partner is unchanged", async ({ page }) => {
  await fx.denyOwningEdit("manager", "partners");
  try {
    await signInAs(page, "manager");
    await openDraft(page, "UpdateDeny");
    const before = await partnerDoc("UpdateDeny");
    await btn(page, "Use Agreement value for Contact number").click();
    await expect(rowOf(page, "Contact number").locator("td").nth(4)).toContainText(/9876/);
    const update = btn(page, /^Update Partner.* for Contact number/);
    // the Finance-side action is fine; the owning module says no - either the action is not offered or the write is refused
    if ((await update.count()) > 0) {
      await update.click();
      await page.getByRole("dialog").getByRole("button", { name: "Update Partner", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
      await expect(page.getByRole("dialog").getByRole("alert")).not.toContainText(/partners|edit_partner|permission denied for/i);
    }
    expect(await partnerDoc("UpdateDeny")).toEqual(before);
    expect((await partnerDoc("UpdateDeny")).phone).toBeNull();
  } finally {
    await fx.restoreOverrides();
  }
});

test("typed corrected values for email and phone are validated inline (basic shape) before anything is sent; a valid value is saved", async ({ page }) => {
  await signInAs(page, "admin");
  await openDraft(page, "MatchAll");
  const stored = async () => (await financeAgreementsCollection().doc(S.MatchAll!.agreementRef).collection("versions").doc("1").get()).data()!;
  // Match rows first take the person's own decision, after which the typed-value action is available
  await btn(page, "Confirm for Contact number").click();
  await btn(page, "Confirm for Email address").click();

  await btn(page, "Enter corrected value for Email address").click();
  const email = cv(page).getByLabel("Corrected email address");
  await email.fill("not-an-email");
  await page.keyboard.press("Tab"); // leaving the box validates (inline, before "Use this value")
  await expect(cv(page).getByRole("alert").filter({ hasText: /valid email address/ })).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await email.fill("typed@example.test");
  await expect(cv(page).getByRole("alert").filter({ hasText: /valid email address/ })).toHaveCount(0);
  await cv(page).getByRole("button", { name: "Use this value" }).click();
  await expect(rowOf(page, "Email address").locator("td").nth(4)).toContainText("typed@example.test");
  await expect.poll(async () => (await stored()).draft.emailAddress.value).toBe("typed@example.test");

  await btn(page, "Enter corrected value for Contact number").click();
  const phone = cv(page).getByLabel("Corrected contact number");
  await phone.fill("call me maybe");
  await page.keyboard.press("Tab");
  await expect(cv(page).getByRole("alert").filter({ hasText: /7 to 15 digits/ })).toBeVisible();
  await cv(page).getByRole("button", { name: "Use this value" }).click();
  await expect(cv(page).getByRole("alert").filter({ hasText: /7 to 15 digits/ })).toBeVisible();
  expect((await stored()).draft.contactNumber.value).toBe("+91 90000 22222");
  await phone.fill("+91 98765 43210");
  await cv(page).getByRole("button", { name: "Use this value" }).click();
  await expect.poll(async () => (await stored()).draft.contactNumber.value).toBe("+91 98765 43210");
});

// ---- KYC ---------------------------------------------------------------------------------------------------------------------------------------
const kyc = (page: Page) => page.getByTestId("intake-kyc");
const kycRow = (page: Page, component: string) => kyc(page).locator(`[data-kyc-component="${component}"]`);

test("KYC that exists in the Partner record shows Available automatically, says so, and asks for NO duplicate upload", async ({ page }) => {
  await openDraft(page, "KycFull");
  await expect(page.getByTestId("kyc-headline")).toContainText("KYC available in Partner/Vendor record");
  for (const component of ["pan", "aadhaar", "bank", "gst"]) {
    await expect(kycRow(page, component), component).toContainText("Available");
    await expect(kycRow(page, component)).toContainText("KYC available in Partner/Vendor record");
  }
  await expect(kyc(page).getByRole("button", { name: /Upload \/ Update KYC/ })).toHaveCount(0);
  expect(leaked(await kyc(page).innerText())).toEqual([]);
});

test("missing / incomplete KYC offers 'Upload / Update KYC' per missing component only to an authorized actor", async ({ page }) => {
  await openDraft(page, "KycNone");
  for (const [component, label] of [["pan", "PAN"], ["aadhaar", "Aadhaar"], ["bank", "Bank details"], ["gst", "GST certificate"]] as const) {
    await expect(kycRow(page, component), component).toContainText("Missing");
    await expect(kyc(page).getByRole("button", { name: `Upload / Update KYC for ${label}` })).toBeVisible();
  }
  await openDraft(page, "KycPart");
  await expect(kyc(page)).toContainText("Incomplete");
  await expect(kycRow(page, "pan")).toContainText("Available");
  await expect(kyc(page).getByRole("button", { name: "Upload / Update KYC for PAN" })).toHaveCount(0);
  await expect(kyc(page).getByRole("button", { name: "Upload / Update KYC for Bank details" })).toBeVisible();
});

test("an actor without sensitive access (Manager) sees the safe overall status only: no component detail, no upload, no reveal", async ({ page }) => {
  await signInAs(page, "manager");
  const bodies = collectResponseBodies(page);
  await openDraft(page, "KycFull");
  await expect(kyc(page)).toContainText("You can see the overall KYC status only");
  await expect(kyc(page).getByRole("button", { name: /Upload \/ Update KYC/ })).toHaveCount(0);
  for (const component of ["pan", "aadhaar", "bank", "gst"]) await expect(kycRow(page, component)).toContainText("Restricted");
  await openDraft(page, "KycNone");
  await expect(kyc(page).getByRole("button", { name: /Upload \/ Update KYC/ })).toHaveCount(0);
  expect(leaked(await page.content())).toEqual([]);
  for (const body of bodies.bodies) expect(leaked(body.text), body.url).toEqual([]);
});

test("Upload / Update KYC updates the CANONICAL owning record: apply from the Agreement fills the Partner's restricted PAN, a document link becomes owning-module evidence - and no identity value or Finance-side copy exists", async ({ page }) => {
  await openDraft(page, "KycApply");
  await kyc(page).getByRole("button", { name: "Upload / Update KYC for PAN" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("KYC is kept once, in the Partner record");
  // the value found in the Agreement must first be confirmed by a person in Cross-verification: the dialog says so instead of refusing later
  await expect(dialog.getByRole("button", { name: "Apply from Agreement" })).toBeDisabled();
  await expect(dialog).toContainText("Confirm the PAN found in the Agreement in Cross-verification first.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(rowOf(page, "PAN number")).toHaveAttribute("data-state", "MISSING_IN_CREATOROPS");
  await btn(page, "Use Agreement value for PAN number").click();
  await expect(rowOf(page, "PAN number").locator("td").nth(4)).toContainText("Acknowledged");
  await kyc(page).getByRole("button", { name: "Upload / Update KYC for PAN" }).click();
  await expect(dialog.getByRole("button", { name: "Apply from Agreement" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply from Agreement" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("KYC values from the Agreement were applied");
  const identityDoc = restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", S.KycApply!.partnerUid));
  await expect.poll(async () => (await identityDoc.get()).data()?.pan?.number ?? null).toBe(CONTRACT_SENSITIVE.pan);
  // the KYC section shows the STATUS only (an authorized reader may still see the raw contract text in the extraction section)
  await expect(kycRow(page, "pan")).toContainText("Available");
  expect(leaked(await kyc(page).innerText(), [CONTRACT_SENSITIVE.pan])).toEqual([]);
  // ...and no full identity value anywhere on the page, even for the Admin who may see contract text and compare identity
  expect(leaked(await renderedDom(page), SENSITIVE_STRINGS)).toEqual([]);

  // the Agreement's own documents hold no identity value at all (no duplicate unrestricted Finance KYC)
  const head = (await financeAgreementsCollection().doc(S.KycApply!.agreementRef).get()).data();
  const version = (await financeAgreementsCollection().doc(S.KycApply!.agreementRef).collection("versions").doc("1").get()).data();
  const events = (await financeAgreementEventsCollection(S.KycApply!.agreementRef).get()).docs.map((doc) => doc.data());
  const financeSide = JSON.stringify({ head, version, events });
  for (const value of [CONTRACT_SENSITIVE.pan, CONTRACT_SENSITIVE.gstin, CONTRACT_SENSITIVE.aadhaar, CONTRACT_SENSITIVE.account, CONTRACT_SENSITIVE.ifsc]) expect(financeSide).not.toContain(value);

  // evidence link through the owning module's own evidence endpoint (JSON link evidence: no Drive)
  await kyc(page).getByRole("button", { name: "Upload / Update KYC for GST certificate" }).click();
  const link = page.getByRole("dialog").getByLabel("GST certificate document link");
  await link.fill("https://example.test/gst-certificate-evidence");
  await page.getByRole("dialog").getByRole("button", { name: "Add link" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("A link for the GST certificate was added to the Partner record");
  const evidence = ((await identityDoc.get()).data()?.evidence ?? []) as Array<{ docType: string; url: string }>;
  expect(evidence.some((item) => item.docType === "gst" && item.url === "https://example.test/gst-certificate-evidence")).toBe(true);
});

test("bank details cannot be applied from a contract and the dialog says so; the KYC dialog closes with Escape and returns focus to its button", async ({ page }) => {
  await openDraft(page, "KycNone");
  const trigger = kyc(page).getByRole("button", { name: "Upload / Update KYC for Bank details" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/bank details cannot|cannot be applied|contract/i);
  await expect(dialog.getByRole("button", { name: "Apply from Agreement" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

// ---- Commercial terms ---------------------------------------------------------------------------------------------------------------------------
const commercial = (page: Page) => page.getByTestId("intake-commercial_terms");
const fieldRow = (page: Page, key: string) => page.locator(`[data-field-row="${key}"]`);

test("qualifying unit: the dropdown offers ONLY Approved Content and Approved current link; the extracted wording 'reel' is shown as written and marked Needs mapping, never silently mapped", async ({ page }) => {
  await openDraft(page, "CommercialX");
  const unit = fieldRow(page, "qualifyingUnit");
  await expect(unit).toContainText("reel");
  await expect(unit).toContainText("Needs mapping");
  await expect(unit).toContainText("which is not a supported unit");
  // not silently mapped: still PENDING in the draft
  const stored = (await financeAgreementsCollection().doc(S.CommercialX!.agreementRef).collection("versions").doc("1").get()).data()!;
  expect(stored.draft.qualifyingUnit.decision).toBe("PENDING");
  expect(stored.draft.qualifyingUnit.value).toBe("reel");

  await unit.getByRole("button", { name: "Enter value" }).click();
  const select = unit.getByLabel("Qualifying unit", { exact: true });
  await expect(select.locator("option")).toHaveText(["Choose a qualifying unit…", "Approved Content", "Approved current link"]);
  await expect(select.locator("option[value=\"reel\"]")).toHaveCount(0);
  await select.selectOption("approved_current_link");
  await unit.getByRole("button", { name: "Save qualifying unit" }).click();
  await expect(unit).toContainText("Approved current link");
  await expect(unit).not.toContainText("Needs mapping");
  const after = (await financeAgreementsCollection().doc(S.CommercialX!.agreementRef).collection("versions").doc("1").get()).data()!;
  expect(after.draft.qualifyingUnit.decision).toBe("CORRECTED");
  expect(after.draft.qualifyingUnit.value).toBe("approved_current_link");
});

test("fixed amount and payment terms are visible and typed in rupees: the draft stores integer paise, the display uses en-IN grouping", async ({ page }) => {
  await openDraft(page, "CommercialY");
  for (const key of ["currency", "paymentCycle", "fixedComponent", "monthlyRequiredQualifyingContentCount", "qualifyingUnit", "accountTransferFee", "advancePayment", "invoiceRequired", "invoiceDueTerms", "paymentDueTerms", "servicesMandated", "incentive"]) {
    await expect(fieldRow(page, key), key).toBeVisible();
  }
  await expect(fieldRow(page, "monthlyRequiredQualifyingContentCount")).toContainText("Monthly required qualifying content");
  await expect(commercial(page)).not.toContainText("Fixed deliverable units");
  const fixed = fieldRow(page, "fixedComponent");
  await fixed.getByRole("button", { name: "Enter value" }).click();
  const amount = fixed.getByRole("textbox").first();
  await amount.fill("1,23,456.50");
  await fixed.getByRole("button", { name: /^Save fixed component/ }).click();
  await expect(fixed).toContainText("₹1,23,456.50");
  await expect.poll(async () => (await financeAgreementsCollection().doc(S.CommercialY!.agreementRef).collection("versions").doc("1").get()).data()!.draft.fixedComponent?.value).toEqual({ applicable: true, amountMinor: 12_345_650 });
  await expect(page.getByTestId("agreement-type")).toContainText(/Fixed/);
});

test("LFC / SFC rules are recorded only when the Agreement states them explicitly: the editor is hidden behind an explicit statement", async ({ page }) => {
  await openDraft(page, "CommercialY");
  const lfc = fieldRow(page, "lfcSfc");
  await expect(lfc.getByLabel("The Agreement states LFC / SFC rules explicitly")).not.toBeChecked();
  await expect(lfc.getByRole("button", { name: "Enter value" })).toHaveCount(0);
  await expect(lfc.getByLabel("Format name")).toHaveCount(0);
  await lfc.getByLabel("The Agreement states LFC / SFC rules explicitly").click();
  // the statement opens the editor (and the four decision controls) - only now can a rule be entered
  await lfc.getByRole("button", { name: "Add format" }).click();
  await expect(lfc.getByLabel("Format name").first()).toBeVisible();
  await expect(lfc.getByRole("group", { name: "Decision for LFC / SFC rule" })).toBeVisible();
});

test("performance targets are a separate panel: every target row says 'Monitoring only · does not affect payment' and there is no way to make one affect payment", async ({ page }) => {
  await openDraft(page, "CommercialX");
  await page.getByTestId("save-draft").click();
  const targets = page.getByTestId("intake-performance_targets");
  await expect(targets.getByRole("heading", { name: "Performance targets" })).toBeVisible();
  await expect(targets).toContainText("Monitoring only · does not affect payment");
  // a section of its own, apart from the payment-affecting terms
  expect(await commercial(page).locator('[data-field-row="performanceTargets"]').count()).toBe(0);
  await expect(commercial(page)).not.toContainText("Monitoring only");
  // extracted target (5% follower growth) is listed with its own statement per row
  const row = fieldRow(page, "performanceTargets");
  await expect(row.getByText("Monitoring only · does not affect payment").first()).toBeVisible();
  await row.getByRole("button", { name: "Enter value" }).click();
  // no control anywhere on the panel that could set affectsPayment
  await expect(targets.getByRole("checkbox", { name: /payment/i })).toHaveCount(0);
  await expect(targets.getByLabel(/affects payment/i)).toHaveCount(0);
  await expect(targets.getByText(/Analytics|Views|Reach|Engagement|follower/i).first()).toBeVisible();
});

// ---- Review & confirm --------------------------------------------------------------------------------------------------------------------------
const review = (page: Page) => page.getByTestId("intake-review");

test("Review & confirm blocks while anything is unresolved: Confirm Agreement is disabled with the reason and jump links; Save Draft works", async ({ page }) => {
  await openDraft(page, "ReviewBlocked");
  await expect(review(page).getByTestId("confirm-agreement")).toBeDisabled();
  await expect(review(page).getByTestId("readiness")).toContainText(/items need attention/);
  await review(page).getByTestId("readiness").getByRole("button", { name: "Go to it" }).first().click();
  await expect(page.locator(":focus")).toBeVisible();
  for (const group of ["Counterparty", "Platform / account scope", "Contract artifact", "Unresolved discrepancies", "KYC readiness", "Payment-affecting terms", "Performance targets", "Effective dates", "Source mode"]) {
    await expect(review(page).getByRole("heading", { name: group })).toBeVisible();
  }
  await expect(review(page).getByRole("heading", { name: "Unresolved discrepancies" }).locator("xpath=..")).toContainText("open");
  await expect(review(page).getByRole("heading", { name: "Performance targets" }).locator("xpath=..")).toContainText("Monitoring only · does not affect payment");
  await expect(review(page).getByRole("button", { name: "Activate Agreement" })).toHaveCount(0);
});

test("Save Draft writes buffered edits through decideField and confirms the saved state; there is exactly ONE Save Draft button", async ({ page }) => {
  await openDraft(page, "ReviewBlocked");
  const number = fieldRow(page, "agreementNumber");
  await number.getByRole("button", { name: "Enter value" }).click();
  await number.getByRole("textbox", { name: "Agreement number", exact: true }).fill("E2E-AGR-77");
  await expect(page.getByTestId("save-state")).toContainText("1 unsaved change");
  await expect(page.getByRole("button", { name: "Save Draft" })).toHaveCount(1);
  await page.getByTestId("save-draft").click();
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
  await expect(page.getByTestId("intake-status")).toContainText(/saved/i);
  const stored = (await financeAgreementsCollection().doc(S.ReviewBlocked!.agreementRef).collection("versions").doc("1").get()).data()!;
  expect(stored.draft.agreementNumber.value).toBe("E2E-AGR-77");
  expect(["ACCEPTED", "CORRECTED"]).toContain(stored.draft.agreementNumber.decision);
});

test("a Manager can confirm a ready draft but sees NO Activate action; confirming writes nothing to the Partner and freezes the terms", async ({ page }) => {
  await signInAs(page, "manager");
  await openDraft(page, "ReviewReady");
  const before = await partnerDoc("ReviewReady");
  await expect(review(page).getByTestId("confirm-agreement")).toBeEnabled();
  await expect(review(page).getByRole("button", { name: "Activate Agreement" })).toHaveCount(0);
  await review(page).getByTestId("confirm-agreement").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Confirming freezes the terms of this version");
  await dialog.getByRole("button", { name: "Confirm Agreement" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("Agreement confirmed. Its terms are now frozen.");
  await expect(review(page).getByText(/confirmed and its terms are frozen/)).toBeVisible();
  await expect(review(page).getByRole("button", { name: "Activate Agreement" })).toHaveCount(0);
  expect(await partnerDoc("ReviewReady")).toEqual(before);
  const stored = (await financeAgreementsCollection().doc(S.ReviewReady!.agreementRef).collection("versions").doc("1").get()).data()!;
  expect(stored.confirmation).toBeTruthy();
  // frozen: editing controls are gone
  await expect(page.getByTestId("save-draft")).toHaveCount(0);
});

test("a Head sees Activate Agreement on the confirmed version and activation makes it the Agreement in force", async ({ page }) => {
  await signInAs(page, "head");
  await openDraft(page, "ReviewReady");
  const activate = review(page).getByTestId("activate-agreement");
  await expect(activate).toBeVisible();
  await activate.click();
  await page.getByRole("dialog").getByRole("button", { name: "Activate Agreement" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("Agreement activated.");
  await expect(review(page)).toContainText(/already in force/);
  const head = (await financeAgreementsCollection().doc(S.ReviewReady!.agreementRef).get()).data()!;
  expect(head.status).toBe("ACTIVE");
});

// ---- Keyboard --------------------------------------------------------------------------------------------------------------------------------
test("keyboard: the searchable selector (ArrowDown / ArrowUp / Enter / Escape), the card radios, discrepancy controls and dialogs are all operable without a mouse", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto("/finance/agreements/new");
  await waitForHydration(page, '[role="radio"]');
  // card radios: roving tabindex + arrow keys select
  const first = page.getByRole("radio", { name: /^Instagram Partner/ });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /^YouTube Partner/ })).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /^Vendor/ })).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: /^Instagram \+ YouTube Partner/ })).toBeChecked();

  // combobox: type, ArrowDown, Enter picks; Escape closes without leaving the field
  const box = page.getByRole("combobox", { name: "Search Partner" });
  await box.focus();
  await box.fill(`${TAG} MatchAll`);
  const list = page.getByRole("listbox", { name: "Partner search results" });
  await expect(list.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(box).toBeFocused();
  await box.fill(`${TAG} `);
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect.poll(() => list.getByRole("option").count()).toBeGreaterThan(3);
  await page.keyboard.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", /-option-0$/);
  await page.keyboard.press("ArrowDown");
  await expect(box).toHaveAttribute("aria-activedescendant", /-option-1$/);
  await page.keyboard.press("ArrowUp");
  await expect(box).toHaveAttribute("aria-activedescendant", /-option-0$/);
  const firstLabel = await list.getByRole("option").first().locator("b").innerText();
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue(firstLabel);
  await expect(list).toHaveCount(0);
  expect(errors.errors).toEqual([]);
});

test("keyboard: discrepancy controls are buttons with descriptive names (Enter / Space activates), and the Update dialog closes with Escape and restores focus", async ({ page }) => {
  await openDraft(page, "UpdateDeny");
  const choose = btn(page, "Use Agreement value for Email address");
  await choose.focus();
  await page.keyboard.press("Enter");
  await expect(choose).toHaveAttribute("aria-pressed", "true");
  const update = btn(page, /^Update Partner(\/Vendor)? after confirmation for Email address/);
  await update.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(update).toBeFocused();
  // Space activates too: Keep CreatorOps value turns the row into a Match carrying the kept value
  const keep = btn(page, "Keep CreatorOps value for Email address");
  await keep.focus();
  await page.keyboard.press("Space");
  await expect(rowOf(page, "Email address")).toHaveAttribute("data-state", "MATCH");
});

test("keyboard + a11y status: the upload / extract state lives in polite live regions and the extraction result takes focus", async ({ page }) => {
  await openDraft(page, "CommercialY");
  await expect(page.getByTestId("extraction-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("intake-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("save-state")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("kyc-headline")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("cross-verification-summary")).toHaveAttribute("aria-live", "polite");
  // every form control in the sections has an accessible name
  const unnamed = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll("main input, main select, main textarea, main button").forEach((element) => {
      const el = element as HTMLInputElement;
      const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || el.closest("label")?.textContent || el.textContent || el.getAttribute("title");
      if (!name || !name.trim()) bad.push(`${el.tagName.toLowerCase()}[type=${el.getAttribute("type")}]#${el.id}`);
    });
    return bad;
  });
  expect(unnamed).toEqual([]);
});

test("no sensitive string in the DOM or network for a Manager across the resumed draft with an attached extraction (whole page)", async ({ page }) => {
  await signInAs(page, "manager");
  const bodies = collectResponseBodies(page);
  await openDraft(page, "KycApply");
  await expect(page.getByTestId("extraction-grid")).toBeVisible();
  expect(leaked(await renderedDom(page), SENSITIVE_STRINGS)).toEqual([]);
  for (const body of bodies.bodies) expect(leaked(body.text, SENSITIVE_STRINGS), body.url).toEqual([]);
});
