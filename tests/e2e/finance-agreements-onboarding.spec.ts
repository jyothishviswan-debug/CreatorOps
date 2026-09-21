import { test } from "@playwright/test";

import {
  collectBrowserErrors,
  collectResponseBodies,
  createFinanceFixtures,
  renderedDom,
  signInAs,
  uniqueIdentity,
  type FinanceFixtures,
} from "./helpers/finance-agreements-fixtures";
import { CONTRACT_SENSITIVE, makeContractPdf, noDocumentOverflow, VIEWPORTS } from "./helpers/finance-agreements-fixtures";
import { checkDuplicates, expect, extractInWizard, field, openNewAgreement, openWizard, pdfFile, radio, shot, shotEl } from "./helpers/finance-onboarding-helpers";
import { financeAgreementsCollection, financeContractArtifactsCollection } from "@/server/finance-agreements/firestore";
import { partnerAccountsCollection, partnerEventsCollection, partnersCollection } from "@/server/partners/firestore";
import { vendorEventsCollection, vendorPartnerLinksCollection, vendorsCollection } from "@/server/vendors/firestore";
import { financeAgreementClaimsCollection } from "@/server/finance-agreements/firestore";

// Step 14B.1 e2e: Agreement-led NEW PARTNER onboarding through the real UI. Hermetic: private-region fixtures, unique tag, unique identities per test,
// everything (including what the browser created) removed in afterAll. Run on the PRIVATE Playwright emulator only.

test.describe.configure({ mode: "serial" });

const TAG = `FOB${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

async function partnersNamed(name: string) {
  return (await partnersCollection().where("displayName", "==", name).get()).docs.map((doc) => doc.data());
}

// ---------------------------------------------------------------------------------------------------------------------------------------
test("Agreement-for: the existing flow is the DEFAULT and unchanged; the mode choice names `Select existing Partner` / `Create new Partner from Agreement` (Vendor equivalents)", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openNewAgreement(page);
  // before any card is chosen: no mode choice
  await expect(page.getByRole("radiogroup")).toHaveCount(1);

  await radio(page, /^Instagram Partner/).click();
  const modeGroup = page.getByRole("radiogroup").nth(1);
  await expect(modeGroup.getByRole("radio")).toHaveText([/Select existing Partner/, /Create new Partner from Agreement/]);
  // existing is preselected: the counterparty search is there and Start draft exists; nothing of the wizard
  await expect(radio(page, /^Select existing Partner/)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("combobox", { name: "Search Partner" })).toBeVisible();
  await expect(page.getByTestId("start-draft")).toBeVisible();
  await expect(page.getByTestId("section-onboarding-upload")).toHaveCount(0);
  await shot(page, "01-agreement-for-mode-existing");

  // Partner platform choices still exist next to the mode choice
  await radio(page, /^YouTube Partner/).click();
  await expect(radio(page, /^Select existing Partner/)).toBeVisible();
  await radio(page, /^Instagram \+ YouTube Partner/).click();
  await expect(radio(page, /^Create new Partner from Agreement/)).toBeVisible();

  // Vendor equivalents
  await radio(page, /^Vendor/).click();
  await expect(page.getByRole("radiogroup").nth(1).getByRole("radio")).toHaveText([/Select existing Vendor/, /Create new Vendor from Agreement/]);
  await expect(page.getByRole("combobox", { name: "Search Vendor" })).toBeVisible();

  // choosing `Create new` swaps the search for the wizard (and hides Start draft)
  await radio(page, /^Create new Vendor from Agreement/).click();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByTestId("start-draft")).toHaveCount(0);
  await expect(page.getByTestId("section-onboarding-upload")).toBeVisible();
  await expect(page.getByText("No represented Partner is created or linked.")).toBeVisible();
  await shot(page, "02-agreement-for-mode-new-vendor");
  // and back to existing restores it
  await radio(page, /^Select existing Vendor/).click();
  await expect(page.getByRole("combobox", { name: "Search Vendor" })).toBeVisible();
  await expect(page.getByTestId("section-onboarding-upload")).toHaveCount(0);
  expect(errors.errors).toEqual([]);
});

test("NEW PARTNER: upload + extract works with NO existing Partner and persists NOTHING; the proposed record is prefilled and editable", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("prev");
  const name = `${TAG} Preview Media`;
  const beforeAgreements = (await financeAgreementsCollection().get()).size;
  const beforeClaims = (await financeAgreementClaimsCollection().get()).size;
  const beforePartners = (await partnersCollection().get()).size;

  await openWizard(page, "INSTAGRAM_PARTNER");
  // nothing to review yet: the record step says to read the Agreement first, Extract is disabled until a file is chosen
  await expect(page.getByTestId("onboarding-extract")).toBeDisabled();
  await expect(page.getByText("Read the signed Agreement above first.")).toBeVisible();
  await shot(page, "03-wizard-upload-empty");

  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/`, pageName: `${name} Official` }));
  const result = page.getByTestId("onboarding-preview-result");
  await expect(result).toContainText("Extracted Agreement values");
  await expect(page.getByTestId("onboarding-extraction-chip")).toBeVisible();
  await expect(result).toContainText(name);
  await expect(result).toContainText(id.email);
  await expect(result).toContainText(id.phoneNormalized);
  // identity found is presence ONLY
  await expect(page.getByTestId("onboarding-identity-found")).toContainText("PAN");
  await shot(page, "04-wizard-preview-extracted");

  // proposed record prefilled from the Agreement, editable
  await expect(field(page, /^Name/)).toHaveValue(name);
  await expect(field(page, /^Email address/)).toHaveValue(id.email);
  await expect(field(page, /^Phone number/)).toHaveValue(id.phoneNormalized);
  await expect(field(page, /^State \/ region/)).toHaveValue("Karnataka");
  await expect(field(page, /^Instagram page link/)).toHaveValue(`https://instagram.com/${id.handle}`);
  await field(page, /^Name/).fill(`${name} Edited`);
  await expect(field(page, /^Name/)).toHaveValue(`${name} Edited`);
  await field(page, /^Name/).fill(name);
  await shot(page, "05-wizard-proposed-record");

  // NOTHING persisted: no Partner, no Agreement, no claim / ledger
  expect((await partnersNamed(name)).length).toBe(0);
  expect((await partnersCollection().get()).size).toBe(beforePartners);
  expect((await financeAgreementsCollection().get()).size).toBe(beforeAgreements);
  expect((await financeAgreementClaimsCollection().get()).size).toBe(beforeClaims);
  expect(errors.errors).toEqual([]);
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------
type Created = { partner: FirebaseFirestore.DocumentData; accounts: FirebaseFirestore.DocumentData[]; agreements: FirebaseFirestore.DocumentData[]; events: FirebaseFirestore.DocumentData[] };
async function readCreated(name: string): Promise<Created> {
  const partners = await partnersCollection().where("displayName", "==", name).get();
  expect(partners.size, `Partners named ${name}`).toBe(1);
  const partner = partners.docs[0]!.data();
  const accounts = (await partnerAccountsCollection().where("partnerRef", "==", partner.partnerRef).get()).docs.map((doc) => doc.data());
  const agreements = (await financeAgreementsCollection().where("partnerUid", "==", partner.uid).get()).docs.map((doc) => doc.data());
  const events = (await partnerEventsCollection(partner.uid).get()).docs.map((doc) => doc.data());
  return { partner, accounts, agreements, events };
}

async function goToCreate(page: import("@playwright/test").Page, noun: "Partner" | "Vendor") {
  await checkDuplicates(page, noun);
}

const createButton = (page: import("@playwright/test").Page) => page.getByTestId("onboarding-create");

// ---------------------------------------------------------------------------------------------------------------------------------------
test("NEW PARTNER (Instagram): no strong match found -> the Partner is created through the OWNING service with its Instagram Account, the Agreement is linked, the SAME file is re-uploaded, extracted and attached, and the intake continues", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("ig");
  const name = `${TAG} Instagram Media`;
  const pdf = pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/`, pageName: `${name} Official` }, "ig-agreement.pdf");

  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdf);
  await goToCreate(page, "Partner");
  // Step 14C: never "No duplicate / No existing ... found" - the check cannot prove absence, so it says so.
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("No strong match found");
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("Records stored with a different email or phone format may not be detected.");
  await expect(page.getByTestId("onboarding-duplicates-result")).not.toContainText(/no duplicate|no existing/i);
  await expect(page.getByTestId("onboarding-continue-new")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-confirmed-values")).toContainText(name);
  await shot(page, "06-wizard-no-duplicate-confirmed-values");
  await expect(createButton(page)).toBeEnabled();
  await createButton(page).click();

  // the create hands over to the normal intake of the new draft
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();

  const created = await readCreated(name);
  // owning service: canonical Partner doc + `created` event carrying the provenance marker
  expect(created.partner.email).toBe(id.email);
  expect(created.partner.regionIds).toEqual(["Karnataka"]);
  const createdEvent = created.events.find((event) => event.kind === "created");
  expect(createdEvent?.metadata?.createdVia).toBe("FINANCE_AGREEMENT_ONBOARDING");
  expect(createdEvent?.metadata?.direct).toBe(true);
  // ONE canonical Instagram Account, also with the provenance marker
  expect(created.accounts).toHaveLength(1);
  expect(String(created.accounts[0]!.platform).toLowerCase()).toBe("instagram");
  const accountEvent = created.events.find((event) => event.kind === "account_created");
  expect(accountEvent?.metadata?.createdVia).toBe("FINANCE_AGREEMENT_ONBOARDING");
  // the Agreement links to THAT Partner (and its account)
  expect(created.agreements).toHaveLength(1);
  const counterparty = created.agreements[0]!.counterparty as { type: string; partnerRef: string; partnerAccountRefs: string[] };
  expect(counterparty.partnerRef).toBe(created.partner.partnerRef);
  expect(counterparty.partnerAccountRefs).toEqual([created.accounts[0]!.partnerAccountRef]);
  expect(page.url()).toContain(created.agreements[0]!.agreementRef);

  // the SAME file was re-uploaded, extracted and attached: exactly one artifact for this Partner, with the file's own name, and the draft holds attached proposals
  const artifactsFor = async () => (await financeContractArtifactsCollection().where("counterparty.ref", "==", created.partner.partnerRef).get()).docs;
  await expect.poll(async () => (await artifactsFor()).length, { timeout: 40_000 }).toBe(1);
  expect((await artifactsFor())[0]!.data().fileName).toBe("ig-agreement.pdf");
  // ... and the extraction proposals were attached to the draft as PENDING (never accepted)
  await expect.poll(async () => Object.values(((await financeAgreementsCollection().doc(created.agreements[0]!.agreementRef).collection("versions").doc("1").get()).data()?.draft ?? {}) as Record<string, { decision: string }>).filter((entry) => entry.decision === "PENDING").length, { timeout: 40_000 }).toBeGreaterThan(3);
  await expect(page.getByTestId("intake-contract_source")).toContainText("ig-agreement.pdf");
  // the new record is now the source: the Agreement's values MATCH it (for a NEW counterparty nothing reads as `Missing in CreatorOps` any more)
  await expect(page.getByTestId("cross-verification-contact")).toContainText(id.email, { timeout: 40_000 });
  const contact = page.getByTestId("cross-verification-contact");
  await expect(contact).not.toContainText("Missing in CreatorOps");
  await expect(contact.getByText("Match", { exact: true })).toHaveCount(4); // name, phone, email, state
  await expect(page.getByTestId("cross-verification-platform")).not.toContainText("Missing in CreatorOps");
  await expect(page.getByTestId("cross-verification-platform").getByText("Match", { exact: true })).toHaveCount(3); // platforms, page link, page name
  await shot(page, "07-after-create-intake-continues", { fullPage: false });
  expect(errors.errors).toEqual([]);
});

async function fillAccount(page: import("@playwright/test").Page, platform: "Instagram" | "YouTube", link: string) {
  const input = page.getByTestId(`onboarding-account-${platform.toLowerCase()}`).getByLabel(new RegExp(`^${platform} page link`));
  await input.fill(link);
}

async function createViaWizard(page: import("@playwright/test").Page) {
  await checkDuplicates(page, "Partner");
  await expect(createButton(page)).toBeEnabled();
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
}

test("NEW PARTNER (YouTube): one Partner with ONE YouTube Account; the platform choice never makes a separate identity", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("yt");
  const name = `${TAG} YouTube Media`;
  await openWizard(page, "YOUTUBE_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.youtube.com/@${id.handle}`, pageName: `${name} Channel` }, "yt-agreement.pdf"));
  // one account row, for YouTube only
  await expect(page.getByTestId("onboarding-account-youtube")).toBeVisible();
  await expect(page.getByTestId("onboarding-account-instagram")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-account-youtube").getByLabel(/^YouTube page link/)).toHaveValue(`https://youtube.com/@${id.handle}`);
  await createViaWizard(page);
  const created = await readCreated(name);
  expect(created.accounts).toHaveLength(1);
  expect(String(created.accounts[0]!.platform).toLowerCase()).toBe("youtube");
  expect(created.events.find((event) => event.kind === "account_created")?.metadata?.createdVia).toBe("FINANCE_AGREEMENT_ONBOARDING");
  const counterparty = created.agreements[0]!.counterparty as { partnerRef: string; platformScope: string[] };
  expect(counterparty.partnerRef).toBe(created.partner.partnerRef);
  expect(counterparty.platformScope).toEqual(["youtube"]);
  expect(errors.errors).toEqual([]);
});

test("NEW PARTNER (Instagram + YouTube): ONE Partner, TWO canonical Accounts (one per platform), one Agreement linked to both", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("both");
  const name = `${TAG} Both Media`;
  await openWizard(page, "IG_YT_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/`, pageName: `${name} Official` }, "both-agreement.pdf"));
  await expect(page.getByTestId("onboarding-account-instagram")).toBeVisible();
  await expect(page.getByTestId("onboarding-account-youtube")).toBeVisible();
  await expect(page.getByTestId("onboarding-account-instagram").getByLabel(/^Instagram page link/)).toHaveValue(`https://instagram.com/${id.handle}`);
  // the YouTube page is not in the Agreement: it stays empty until the person enters it - a check cannot run without it
  await expect(page.getByTestId("onboarding-account-youtube").getByLabel(/^YouTube page link/)).toHaveValue("");
  await page.getByTestId("onboarding-check-duplicates").click();
  await expect(page.getByTestId("onboarding-form-issues")).toBeVisible();
  await shot(page, "08-wizard-ig-yt-missing-account", { fullPage: false });
  await fillAccount(page, "YouTube", `https://www.youtube.com/@${id.ytHandle}`);
  await createViaWizard(page);

  const created = await readCreated(name);
  expect(created.accounts).toHaveLength(2);
  expect(created.accounts.map((account) => String(account.platform).toLowerCase()).sort()).toEqual(["instagram", "youtube"]);
  expect(created.agreements).toHaveLength(1);
  const counterparty = created.agreements[0]!.counterparty as { partnerRef: string; partnerAccountRefs: string[]; platformScope: string[] };
  expect(counterparty.partnerRef).toBe(created.partner.partnerRef);
  expect([...counterparty.partnerAccountRefs].sort()).toEqual(created.accounts.map((account) => account.partnerAccountRef).sort());
  expect(counterparty.platformScope).toEqual(["instagram", "youtube"]);
  // no second Partner was created for the second platform
  expect((await partnersCollection().where("email", "==", id.email).get()).size).toBe(1);
  expect(errors.errors).toEqual([]);
});

// ---- duplicates ------------------------------------------------------------------------------------------------------------------------
async function ledgersFor(partnerRef: string) {
  const all = await financeAgreementClaimsCollection().where("kind", "==", "ONBOARDING").get();
  return all.docs.map((doc) => doc.data()).filter((doc) => doc.steps?.counterparty?.ref === partnerRef);
}

test("DUPLICATE: a Partner with the same email + phone is shown as `Possible existing Partner found` (Strong match, why it matched) and `Use existing` starts the Agreement for THAT Partner - nothing new is created", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("dupuse");
  const name = `${TAG} Dup Use Contract Name`;
  const existing = await fx.seedPartner({ displayName: `${TAG} Existing Use Partner`, email: id.email, phone: id.phoneNormalized });
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await checkDuplicates(page, "Partner");
  const result = page.getByTestId("onboarding-duplicates-result");
  await expect(result).toContainText("Possible existing Partner found");
  await expect(result).toHaveAttribute("data-status", "possible");
  const card = page.getByTestId(`onboarding-candidate-${existing.partnerRef}`);
  await expect(card).toContainText(`${TAG} Existing Use Partner`);
  await expect(card).toHaveAttribute("data-strength", "STRONG");
  await expect(card).toContainText("Strong match");
  await expect(card).toContainText("Same email address");
  await expect(card).toContainText("Same phone number");
  // nothing is decided yet: the final step waits for a deliberate choice
  await expect(createButton(page)).toBeDisabled();
  await expect(page.getByTestId("onboarding-create-blocked")).toContainText("Choose an existing Partner, or continue creating a new one.");
  await shot(page, "09-wizard-duplicate-candidates", { fullPage: false });

  await page.getByTestId(`onboarding-use-existing-${existing.partnerRef}`).click();
  await expect(page.getByTestId(`onboarding-use-existing-${existing.partnerRef}`)).toHaveText("Using this record");
  await expect(createButton(page)).toHaveText("Use existing Partner and start Agreement");
  await expect(createButton(page)).toBeEnabled();
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);

  // the Agreement is for the EXISTING Partner; no Partner named like the contract exists
  const heads = (await financeAgreementsCollection().where("partnerUid", "==", existing.uid).get()).docs.map((doc) => doc.data());
  expect(heads).toHaveLength(1);
  expect((heads[0]!.counterparty as { partnerRef: string }).partnerRef).toBe(existing.partnerRef);
  // the platform CHOICE is not lost on the existing-record path: no Account is named (Partner-level), so the intended platform is RECORDED on the draft
  const versionRef = financeAgreementsCollection().doc(heads[0]!.agreementRef).collection("versions").doc("1");
  await expect.poll(async () => ((await versionRef.get()).data()?.draft?.platforms as { value?: string[] } | undefined)?.value, { timeout: 30_000 }).toEqual(["instagram"]);
  expect((await partnersNamed(name)).length).toBe(0);
  expect((await partnersCollection().where("email", "==", id.email).get()).size).toBe(1);
  expect(errors.errors).toEqual([]);
});

test("DUPLICATE: `Continue creating new` on a STRONG match needs an acknowledgement AND a reason; only then a second Partner is created (deliberately), and the decision is recorded", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("dupnew");
  const name = `${TAG} Dup New Contract Name`;
  const existing = await fx.seedPartner({ displayName: `${TAG} Existing New Partner`, email: id.email, phone: id.phoneNormalized });
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await checkDuplicates(page, "Partner");
  await page.getByTestId("onboarding-continue-new").click();
  const ack = page.getByTestId("onboarding-acknowledge");
  await expect(ack).toBeVisible();
  await expect(createButton(page)).toBeDisabled();
  await ack.getByRole("checkbox").check();
  await expect(createButton(page)).toBeDisabled();
  await expect(page.getByTestId("onboarding-decision-message")).toContainText("reason");
  await ack.getByLabel(/^Reason for creating a new Partner/).fill("Same mailbox, but a different business entity.");
  await expect(createButton(page)).toBeEnabled();
  await expect(createButton(page)).toHaveText("Create Partner and start Agreement");
  await shot(page, "10-wizard-continue-new-acknowledgement", { fullPage: false });
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);

  const created = await readCreated(name);
  expect(created.partner.partnerRef).not.toBe(existing.partnerRef);
  expect((await partnersCollection().where("email", "==", id.email).get()).size).toBe(2);
  const ledgers = await ledgersFor(created.partner.partnerRef);
  expect(ledgers).toHaveLength(1);
  expect(ledgers[0]!.duplicateDecision).toEqual({ kind: "CREATE_NEW", acknowledgedDuplicates: true, reasonRecorded: true });
  expect(ledgers[0]!.createdVia).toBe("FINANCE_AGREEMENT_ONBOARDING");
  // the deliberate decision and its reason are recorded in the Agreement activity, and the provenance reads `Created from Finance Agreement onboarding`
  await page.goto(`/finance/agreements/${created.agreements[0]!.agreementRef}?tab=activity`);
  await expect(page.getByRole("tablist", { name: "Agreement sections" })).toBeVisible();
  const activity = page.locator("main");
  await expect(activity).toContainText("Created from Finance Agreement onboarding: the Partner record was created from this Agreement.");
  await expect(activity).toContainText("Reason: Same mailbox, but a different business entity.");
  expect(errors.errors).toEqual([]);
});

test("DUPLICATE: a name-only match is SUPPORTING evidence: listed, but `Continue creating new` needs no acknowledgement", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("dupname");
  const name = `${TAG} Same Name Media`;
  const existing = await fx.seedPartner({ displayName: name, email: `other.${id.email}`, phone: "+91 90000 12345" });
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await checkDuplicates(page, "Partner");
  const card = page.getByTestId(`onboarding-candidate-${existing.partnerRef}`);
  await expect(card).toHaveAttribute("data-strength", "SUPPORTING");
  await expect(card).toContainText("Supporting match");
  await expect(card).toContainText("Same name");
  await page.getByTestId("onboarding-continue-new").click();
  await expect(page.getByTestId("onboarding-acknowledge")).toHaveCount(0);
  await expect(createButton(page)).toBeEnabled();
  expect(errors.errors).toEqual([]);
});

test("DUPLICATE: a STRONG match OUTSIDE the person's access is a neutral blocking message - no name, no ref, no count anywhere in the page, the DOM or the network", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const bodies = collectResponseBodies(page);
  const id = uniqueIdentity("hid");
  const hidden = await fx.seedPartner({ displayName: `${TAG} Hidden Secret Partner`, email: id.email, phone: id.phoneNormalized, regionIds: [fx.hiddenRegion] });
  await signInAs(page, "manager");
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name: `${TAG} Hidden Probe Media`, email: id.email, phone: id.phone, state: "Kerala", pageLink: `https://www.instagram.com/${id.handle}/` }));
  await expect(field(page, /^State \/ region/)).toHaveValue("Kerala");
  await checkDuplicates(page, "Partner");
  const blocked = page.getByTestId("onboarding-duplicates-blocked");
  await expect(blocked).toContainText("A matching Partner already exists outside your access. Ask an administrator to check it before creating a new one.");
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("Possible existing Partner found");
  await expect(page.getByTestId("onboarding-continue-new")).toHaveCount(0);
  await expect(page.locator('[data-testid^="onboarding-candidate-"]')).toHaveCount(0);
  await expect(createButton(page)).toBeDisabled();
  await shot(page, "11-wizard-duplicate-outside-access", { fullPage: false });
  const dom = await renderedDom(page);
  const text = await page.locator("body").innerText();
  for (const secret of [hidden.partnerRef, hidden.uid, "Hidden Secret Partner", fx.hiddenRegion]) {
    expect(dom, `DOM leaks ${secret}`).not.toContain(secret);
    expect(text).not.toContain(secret);
    for (const body of bodies.bodies) expect(body.text, `${body.url} leaks ${secret}`).not.toContain(secret);
  }
  // the server is the truth: a forged create request that skips the check is refused with a typed blocker, and nothing is written
  const forged = await page.request.post("/api/finance/onboarding", {
    data: { clientRequestId: `onboard-forged-${TAG}`, type: "PARTNER", reviewedProfile: { displayName: `${TAG} Hidden Probe Media`, email: id.email, phone: id.phoneNormalized, regionIds: ["Kerala"] }, accounts: [{ platform: "Instagram", profileUrl: `https://instagram.com/${id.handle}` }], duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: true, reason: "forged request" } },
  });
  expect(forged.status()).toBe(409);
  const forgedBody = JSON.stringify(await forged.json());
  expect(forgedBody).toContain("strong_match_outside_access");
  for (const secret of [hidden.partnerRef, hidden.uid, "Hidden Secret Partner"]) expect(forgedBody).not.toContain(secret);
  expect((await partnersCollection().where("email", "==", id.email).get()).size).toBe(1);
  expect((await partnersNamed(`${TAG} Hidden Probe Media`)).length).toBe(0);
  expect(errors.errors).toEqual([]);
});

test("CREATE PROGRESS: while the create request runs the steps are visible (Validate -> Partner -> Accounts -> Agreement draft), announced in a polite status region, and the button cannot be pressed twice", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("prog");
  const name = `${TAG} Progress Media`;
  let posts = 0;
  await page.route("**/api/finance/onboarding", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return route.continue();
  });
  await openWizard(page, "IG_YT_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await fillAccount(page, "YouTube", `https://www.youtube.com/@${id.ytHandle}`);
  await checkDuplicates(page, "Partner");
  await createButton(page).dblclick();
  const steps = page.getByTestId("onboarding-steps");
  await expect(steps).toBeVisible();
  await expect(steps.locator("li")).toHaveCount(4);
  await expect(steps).toContainText("Validate the details");
  await expect(steps).toContainText("Create the Partner");
  await expect(steps).toContainText("Create the Partner Accounts");
  await expect(steps).toContainText("Create the Agreement draft");
  await expect(page.getByTestId("onboarding-create-status")).toHaveAttribute("aria-live", "polite");
  await expect(createButton(page)).toBeDisabled();
  await expect(createButton(page)).toHaveText("Creating…");
  // what is being created stays on screen while it runs
  await expect(page.getByTestId("onboarding-confirmed-values")).toContainText(name);
  await shotEl(page.getByTestId("section-onboarding-create"), "39-wizard-create-progress");
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  expect(posts).toBe(1); // a double click sent ONE request
  expect(await counts(name, id.email)).toEqual({ partners: 1, accounts: 2, agreements: 1 });
  expect(errors.errors).toEqual([]);
});

// ---- retry / resume ----------------------------------------------------------------------------------------------------------------------
async function counts(name: string, email: string) {
  const partners = await partnersCollection().where("email", "==", email).get();
  const partner = partners.docs[0]?.data();
  const accounts = partner ? (await partnerAccountsCollection().where("partnerRef", "==", partner.partnerRef).get()).size : 0;
  const agreements = partner ? (await financeAgreementsCollection().where("partnerUid", "==", partner.uid).get()).size : 0;
  void name;
  return { partners: partners.size, accounts, agreements };
}

test("RETRY: the response of the create request is LOST after the server finished (network failure) -> a recoverable state with Retry; Retry sends the SAME request and creates NO duplicate Partner, Account or Agreement", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("retry");
  const name = `${TAG} Retry Media`;
  let posts = 0;
  const seenIds: string[] = [];
  await page.route("**/api/finance/onboarding", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    seenIds.push(String((route.request().postDataJSON() as { clientRequestId: string }).clientRequestId));
    if (posts === 1) {
      await route.fetch(); // the server runs the WHOLE onboarding ...
      await route.abort("connectionreset"); // ... but the browser never hears about it
      return;
    }
    await route.continue();
  });
  await openWizard(page, "IG_YT_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }, "retry.pdf"));
  await fillAccount(page, "YouTube", `https://www.youtube.com/@${id.ytHandle}`);
  await checkDuplicates(page, "Partner");
  await createButton(page).click();

  const lost = page.getByTestId("onboarding-lost");
  await expect(lost).toBeVisible();
  await expect(lost).toContainText("We could not confirm the result.");
  await expect(lost).toBeFocused();
  await shot(page, "12-wizard-failure-retry", { fullPage: false });
  // the server DID finish: one of each already exists
  expect(await counts(name, id.email)).toEqual({ partners: 1, accounts: 2, agreements: 1 });
  // the wizard is locked (the request body cannot drift under its id)
  await expect(field(page, /^Name/)).toBeDisabled();

  await page.getByTestId("onboarding-retry").click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  expect(posts).toBe(2);
  expect(new Set(seenIds).size).toBe(1); // the retry reused the SAME clientRequestId
  expect(await counts(name, id.email)).toEqual({ partners: 1, accounts: 2, agreements: 1 });
  expect((await ledgersFor((await readCreated(name)).partner.partnerRef)).length).toBe(1);
  expect(errors.errors).toEqual([]);
});

test("RETRY: an HTTP 500 the server never produced (nothing ran) -> the same recoverable state; Retry then creates exactly ONE of everything", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("retry500");
  const name = `${TAG} Retry Five Hundred`;
  let posts = 0;
  await page.route("**/api/finance/onboarding", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    if (posts === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong." }) });
    return route.continue();
  });
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await checkDuplicates(page, "Partner");
  await createButton(page).click();
  await expect(page.getByTestId("onboarding-lost")).toBeVisible();
  expect(await counts(name, id.email)).toEqual({ partners: 0, accounts: 0, agreements: 0 });
  await page.getByTestId("onboarding-retry").click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  expect(await counts(name, id.email)).toEqual({ partners: 1, accounts: 1, agreements: 1 });
  expect(errors.errors).toEqual([]);
});

test("RELOAD-RESUME: the page is reloaded after the lost response -> the wizard asks the server (getOnboardingStatus) where it stopped and opens the created draft; nothing is created twice", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("resume");
  const name = `${TAG} Resume Media`;
  let posts = 0;
  await page.route("**/api/finance/onboarding", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    if (posts === 1) {
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await checkDuplicates(page, "Partner");
  await createButton(page).click();
  await expect(page.getByTestId("onboarding-lost")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
  expect(posts).toBe(1); // resumed from the status read - no second create was even sent
  expect(await counts(name, id.email)).toEqual({ partners: 1, accounts: 1, agreements: 1 });
  // the File is gone after a reload: the normal Contract source asks for it again (nothing lost - the records exist)
  await expect(page.getByTestId("intake-contract_source")).toBeVisible();
  expect(errors.errors).toEqual([]);
});

// ---- authorization ------------------------------------------------------------------------------------------------------------------------
test("SECURITY: a Manager who can manage Agreements but has NO Partner-create right can preview and review, but the create step is blocked with the plain reason and NOTHING is written", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("nocreate");
  const name = `${TAG} No Create Media`;
  await fx.denyOwningAction("manager", "create", "partners");
  try {
    await signInAs(page, "manager");
    await openNewAgreement(page);
    await radio(page, /^Instagram Partner/).click();
    // the mode card says so up front, and stays selectable (review is allowed)
    await expect(radio(page, /^Create new Partner from Agreement/)).toContainText("creating a new Partner needs permission");
    await radio(page, /^Create new Partner from Agreement/).click();
    await expect(page.getByTestId("onboarding-permission-note")).toContainText("You can review, but not create.");
    await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, state: "Kerala", pageLink: `https://www.instagram.com/${id.handle}/` }));
    await expect(field(page, /^Name/)).toHaveValue(name);
    await checkDuplicates(page, "Partner");
    await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("No strong match found");
    await expect(createButton(page)).toBeDisabled();
    await expect(page.getByTestId("onboarding-create-blocked")).toContainText("you do not have permission to create a new Partner");
    await shot(page, "13-wizard-review-only-manager", { fullPage: false });
    // even a forged request is refused before anything is written
    const forged = await page.request.post("/api/finance/onboarding", {
      data: { clientRequestId: `onboard-forged2-${TAG}`, type: "PARTNER", reviewedProfile: { displayName: name, email: id.email, phone: id.phoneNormalized, regionIds: ["Kerala"] }, accounts: [{ platform: "Instagram", profileUrl: `https://instagram.com/${id.handle}` }], duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false } },
    });
    expect(forged.status()).toBe(409);
    expect(JSON.stringify(await forged.json())).toContain("counterparty_create_not_permitted");
    expect(await counts(name, id.email)).toEqual({ partners: 0, accounts: 0, agreements: 0 });
    expect((await partnersNamed(name)).length).toBe(0);
    expect(errors.errors).toEqual([]);
  } finally {
    await fx.restoreOverrides();
  }
});

// ---- NEW VENDOR ----------------------------------------------------------------------------------------------------------------------------
async function vendorsWithEmail(email: string) {
  return (await vendorsCollection().where("email", "==", email).get()).docs.map((doc) => doc.data());
}
async function vendorCounts(email: string) {
  const vendors = await vendorsWithEmail(email);
  const agreements = vendors[0] ? (await financeAgreementsCollection().where("vendorUid", "==", vendors[0].uid).get()).size : 0;
  return { vendors: vendors.length, agreements };
}
async function vendorLinksFor(vendorRef: string) {
  return (await vendorPartnerLinksCollection().where("vendorRef", "==", vendorRef).get()).size;
}

test("NEW VENDOR: the Vendor type is REQUIRED; the Vendor is created through the owning service (event carries the provenance), the Agreement links to it, and NO represented-Partner link and NO Partner Account is created", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("vnd");
  const name = `${TAG} New Vendor Works`;
  const partnersBefore = (await partnersCollection().get()).size;
  await openWizard(page, "VENDOR");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone }, "vendor-agreement.pdf"));
  // a Vendor has no Partner Account rows
  await expect(page.locator('[data-testid^="onboarding-account-"]')).toHaveCount(0);
  await expect(field(page, /^Name/)).toHaveValue(name);
  // Vendor type is required: the check refuses to run and says so
  await expect(field(page, /^Vendor type/)).toHaveValue("");
  await page.getByTestId("onboarding-check-duplicates").click();
  await expect(page.getByTestId("onboarding-form-issues")).toContainText("Choose the Vendor type.");
  await expect(page.getByTestId("onboarding-duplicates-result")).toHaveCount(0);
  await shot(page, "14-wizard-vendor-type-required", { fullPage: false });
  await field(page, /^Vendor type/).selectOption("AGENCY");
  await checkDuplicates(page, "Vendor");
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("No strong match found");
  await expect(createButton(page)).toHaveText("Create Vendor and start Agreement");
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);

  const vendors = await vendorsCollection().where("displayName", "==", name).get();
  expect(vendors.size).toBe(1);
  const vendor = vendors.docs[0]!.data();
  expect(vendor.vendorType).toBe("AGENCY");
  expect(vendor.email).toBe(id.email);
  const events = (await vendorEventsCollection(vendor.uid).get()).docs.map((doc) => doc.data());
  expect(events.find((event) => event.kind === "created")?.metadata?.createdVia).toBe("FINANCE_AGREEMENT_ONBOARDING");
  const heads = (await financeAgreementsCollection().where("vendorUid", "==", vendor.uid).get()).docs.map((doc) => doc.data());
  expect(heads).toHaveLength(1);
  expect((heads[0]!.counterparty as { type: string; vendorRef: string }).type).toBe("VENDOR");
  expect((heads[0]!.counterparty as { vendorRef: string }).vendorRef).toBe(vendor.vendorRef);
  // no represented-Partner relation, no Partner created by the Vendor flow
  expect(await vendorLinksFor(vendor.vendorRef)).toBe(0);
  expect((await partnersCollection().get()).size).toBe(partnersBefore);
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Vendor");
  expect(errors.errors).toEqual([]);
});

test("NEW VENDOR: a Vendor with the same email is a `Possible existing Vendor found` warning; `Use existing` starts the Agreement for it (nothing new); `Continue creating new` needs acknowledgement + reason", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("vdup");
  const existing = await fx.seedVendor({ displayName: `${TAG} Existing Vendor Dup`, email: id.email, phone: id.phoneNormalized });
  const name = `${TAG} Vendor Dup Contract`;
  await openWizard(page, "VENDOR");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone }));
  await field(page, /^Vendor type/).selectOption("OTHER");
  await checkDuplicates(page, "Vendor");
  await expect(page.getByTestId("onboarding-duplicates-result")).toContainText("Possible existing Vendor found");
  const card = page.getByTestId(`onboarding-candidate-${existing.vendorRef}`);
  await expect(card).toHaveAttribute("data-strength", "STRONG");
  await expect(card).toContainText("Same email address");
  await shot(page, "15-wizard-vendor-duplicate", { fullPage: false });

  // Continue creating new: acknowledgement + reason gate (checked, not submitted)
  await page.getByTestId("onboarding-continue-new").click();
  await expect(createButton(page)).toBeDisabled();
  await page.getByTestId("onboarding-acknowledge").getByRole("checkbox").check();
  await expect(createButton(page)).toBeDisabled();
  await page.getByTestId("onboarding-acknowledge").getByLabel(/^Reason for creating a new Vendor/).fill("A separate legal entity that shares the mailbox.");
  await expect(createButton(page)).toBeEnabled();

  // ... but this run uses the EXISTING Vendor instead
  await page.getByTestId(`onboarding-use-existing-${existing.vendorRef}`).click();
  await expect(createButton(page)).toHaveText("Use existing Vendor and start Agreement");
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  const heads = (await financeAgreementsCollection().where("vendorUid", "==", existing.uid).get()).docs.map((doc) => doc.data());
  expect(heads).toHaveLength(1);
  expect((await vendorsWithEmail(id.email)).length).toBe(1);
  expect((await vendorsCollection().where("displayName", "==", name).get()).size).toBe(0);
  expect(errors.errors).toEqual([]);
});

test("NEW VENDOR: deliberately creating a NEW Vendor despite a strong match creates a second Vendor, with the decision recorded in the ledger", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("vnew");
  await fx.seedVendor({ displayName: `${TAG} Existing Vendor New`, email: id.email, phone: id.phoneNormalized });
  const name = `${TAG} Vendor Deliberate New`;
  await openWizard(page, "VENDOR");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone }));
  await field(page, /^Vendor type/).selectOption("MANAGEMENT_COMPANY");
  await checkDuplicates(page, "Vendor");
  await page.getByTestId("onboarding-continue-new").click();
  await page.getByTestId("onboarding-acknowledge").getByRole("checkbox").check();
  await page.getByTestId("onboarding-acknowledge").getByLabel(/^Reason for creating a new Vendor/).fill("Different entity, same shared mailbox.");
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  expect((await vendorsWithEmail(id.email)).length).toBe(2);
  const created = (await vendorsCollection().where("displayName", "==", name).get()).docs[0]!.data();
  expect(created.vendorType).toBe("MANAGEMENT_COMPANY");
  const ledgers = (await financeAgreementClaimsCollection().where("kind", "==", "ONBOARDING").get()).docs.map((doc) => doc.data()).filter((doc) => doc.steps?.counterparty?.ref === created.vendorRef);
  expect(ledgers).toHaveLength(1);
  expect(ledgers[0]!.duplicateDecision).toEqual({ kind: "CREATE_NEW", acknowledgedDuplicates: true, reasonRecorded: true });
  expect(errors.errors).toEqual([]);
});

test("NEW VENDOR: RETRY idempotency - the create response is lost after the server finished; Retry sends the same request and creates NO second Vendor or Agreement", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("vretry");
  const name = `${TAG} Vendor Retry`;
  let posts = 0;
  await page.route("**/api/finance/onboarding", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    if (posts === 1) {
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await openWizard(page, "VENDOR");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone }));
  await field(page, /^Vendor type/).selectOption("PAYEE_BUSINESS");
  await checkDuplicates(page, "Vendor");
  await createButton(page).click();
  await expect(page.getByTestId("onboarding-lost")).toBeVisible();
  expect(await vendorCounts(id.email)).toEqual({ vendors: 1, agreements: 1 });
  await page.getByTestId("onboarding-retry").click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  expect(posts).toBe(2);
  expect(await vendorCounts(id.email)).toEqual({ vendors: 1, agreements: 1 });
  expect(errors.errors).toEqual([]);
});

// ---- five-role matrix ------------------------------------------------------------------------------------------------------------------------
for (const role of ["viewer", "analyst"] as const) {
  test(`FIVE-ROLE MATRIX: ${role} has no Finance access - the new form is the neutral access-denied page and every onboarding API answers one neutral 403`, async ({ page }) => {
    await signInAs(page, role);
    await page.goto("/finance/agreements/new");
    await expect(page).toHaveURL(/\/access-denied\?feature=finance/);
    await expect(page.getByRole("heading", { level: 1, name: "You don’t have access to this area" })).toBeVisible();
    await expect(page.getByTestId("section-onboarding-upload")).toHaveCount(0);
    const id = uniqueIdentity(`role${role}`);
    const pdf = makeContractPdf({ name: `${TAG} Role Probe`, email: id.email, phone: id.phone });
    const preview = await page.request.post("/api/finance/onboarding/preview", { multipart: { counterpartyType: "PARTNER", file: { name: "a.pdf", mimeType: "application/pdf", buffer: pdf } } });
    expect(preview.status()).toBe(403);
    expect(await preview.json()).toEqual({ error: "Forbidden." });
    const duplicates = await page.request.post("/api/finance/onboarding/duplicates", { data: { type: "PARTNER", displayName: "x", email: id.email } });
    expect(duplicates.status()).toBe(403);
    const create = await page.request.post("/api/finance/onboarding", { data: { clientRequestId: `onboard-role-${role}-${TAG}`, type: "PARTNER", reviewedProfile: { displayName: `${TAG} Role Probe`, regionIds: ["Kerala"] }, accounts: [{ platform: "Instagram", handle: id.handle }], duplicateDecision: { kind: "CREATE_NEW", acknowledgedDuplicates: false } } });
    expect(create.status()).toBe(403);
    expect(await create.json()).toEqual({ error: "Forbidden." });
    const status = await page.request.get("/api/finance/onboarding?clientRequestId=onboard-anything");
    expect(status.status()).toBe(403);
    const docs = await page.request.get("/api/finance/counterparties/documents?counterpartyType=PARTNER&ref=nothing");
    expect(docs.status()).toBe(403);
    expect((await partnersNamed(`${TAG} Role Probe`)).length).toBe(0);
  });
}

for (const role of ["admin", "head", "manager"] as const) {
  test(`FIVE-ROLE MATRIX: ${role} reaches the wizard; the preview never carries an identity value and raw contract text only for a holder of finance_contracts`, async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const bodies = collectResponseBodies(page);
    await signInAs(page, role);
    const id = uniqueIdentity(`role${role}`);
    await openWizard(page, "INSTAGRAM_PARTNER");
    await expect(radio(page, /^Create new Partner from Agreement/)).toContainText("Read the signed Agreement, check for an existing Partner, then create one.");
    await extractInWizard(page, pdfFile({ name: `${TAG} Role ${role}`, email: id.email, phone: id.phone, state: "Kerala", pageLink: `https://www.instagram.com/${id.handle}/` }));
    const canSeeContract = role !== "manager";
    // raw contract text (a details/summary) exists only for finance_contracts holders
    await expect(page.getByTestId("onboarding-preview-result").getByText("Contract text", { exact: true })).toHaveCount(canSeeContract ? 1 : 0);
    // presence flags only: the chips say a PAN was FOUND, never what it is
    await expect(page.getByTestId("onboarding-identity-found")).toContainText("PAN found in Agreement");
    const dom = await renderedDom(page);
    for (const value of [CONTRACT_SENSITIVE.pan, CONTRACT_SENSITIVE.gstin, CONTRACT_SENSITIVE.aadhaar, CONTRACT_SENSITIVE.aadhaarSpaced, CONTRACT_SENSITIVE.account, CONTRACT_SENSITIVE.ifsc]) {
      expect(dom, `${role} DOM shows ${value}`).not.toContain(value);
      for (const body of bodies.bodies.filter((entry) => entry.url.includes("/onboarding"))) expect(body.text, `${role} ${body.url} carries ${value}`).not.toContain(value);
    }
    const previewBody = bodies.bodies.find((entry) => entry.url.includes("/api/finance/onboarding/preview"));
    expect(previewBody, "the preview response was captured").toBeTruthy();
    const preview = JSON.parse(previewBody!.text) as { contractDetailVisible: boolean; snippets: unknown[] | null; canCreateCounterparty: boolean };
    expect(preview.contractDetailVisible).toBe(canSeeContract);
    expect(preview.snippets === null).toBe(!canSeeContract);
    expect(preview.canCreateCounterparty).toBe(true);
    expect(errors.errors).toEqual([]);
  });
}

// ---- keyboard ------------------------------------------------------------------------------------------------------------------------------
test("KEYBOARD: the Agreement-for cards and the mode radios are ONE roving radio group each (arrow keys move and select; only the selected card is in the tab order)", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openNewAgreement(page);
  const first = radio(page, /^Instagram Partner/);
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, /^YouTube Partner/)).toBeFocused();
  await expect(radio(page, /^YouTube Partner/)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await expect(radio(page, /^Vendor/)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Home");
  await expect(first).toHaveAttribute("aria-checked", "true");
  // roving tabindex: only the checked radio of a group is tabbable
  await expect(first).toHaveAttribute("tabindex", "0");
  await expect(radio(page, /^YouTube Partner/)).toHaveAttribute("tabindex", "-1");

  // the mode group: default existing; ArrowRight -> create new (the wizard opens), ArrowLeft -> back to the search
  const existing = radio(page, /^Select existing Partner/);
  await existing.focus();
  await expect(existing).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, /^Create new Partner from Agreement/)).toBeFocused();
  await expect(radio(page, /^Create new Partner from Agreement/)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("section-onboarding-upload")).toBeVisible();
  await expect(existing).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowLeft");
  await expect(existing).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("combobox", { name: "Search Partner" })).toBeVisible();
  expect(errors.errors).toEqual([]);
});

test("KEYBOARD + LIVE REGIONS: the wizard is operable without a mouse - Extract and Check by Enter, focus lands on each result, progress is announced in polite status regions", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("kbd");
  await openWizard(page, "INSTAGRAM_PARTNER");
  // the live regions exist from the start (so the first message is heard)
  for (const testId of ["onboarding-preview-status"]) {
    await expect(page.getByTestId(testId)).toHaveAttribute("role", "status");
    await expect(page.getByTestId(testId)).toHaveAttribute("aria-live", "polite");
  }
  await page.getByTestId("onboarding-file").setInputFiles(pdfFile({ name: `${TAG} Keyboard Media`, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await page.getByTestId("onboarding-extract").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding-preview-result")).toBeFocused();
  await expect(page.getByTestId("onboarding-preview-status")).toContainText("Extraction finished");
  // the record's fields are reachable by Tab in reading order; the checked field is labelled and required fields say so
  await field(page, /^Name/).focus();
  await expect(field(page, /^Name/)).toHaveAttribute("aria-required", "true");
  await page.getByTestId("onboarding-check-duplicates").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding-duplicates-result")).toBeFocused();
  await expect(page.getByTestId("onboarding-duplicates-status")).toContainText("No strong match found");
  // the create button is a real, focusable button whose disabled reason is a visible sentence (never only a grey button)
  await createButton(page).focus();
  await expect(createButton(page)).toBeFocused();
  // an invalid form: the first problem takes focus and is announced by role=alert
  await field(page, /^Email address/).fill("not-an-email");
  await page.getByTestId("onboarding-check-duplicates").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding-form-issues")).toHaveAttribute("role", "alert");
  await expect(field(page, /^Email address/)).toBeFocused();
  await expect(field(page, /^Email address/)).toHaveAttribute("aria-invalid", "true");
  expect(errors.errors).toEqual([]);
});

// ---- responsive ---------------------------------------------------------------------------------------------------------------------------
// The onboarding wizard in EACH phase (empty upload / extracted + proposed record / duplicate candidates / failure with Retry) at every width,
// measured on document.documentElement, with zero console errors / pageerrors.
async function expectNoOverflow(page: import("@playwright/test").Page, width: number, phase: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${phase} @${width}: document scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`).toBeLessThanOrEqual(innerWidth);
}

for (const width of VIEWPORTS) {
  test(`RESPONSIVE @${width}: the new-Partner wizard has no horizontal page overflow in any phase and no console errors`, async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.setViewportSize({ width, height: width < 800 ? 900 : 800 });
    const id = uniqueIdentity(`rsp${width}`);
    const existing = await fx.seedPartner({ displayName: `${TAG} Responsive Existing ${width} With A Deliberately Long Display Name To Test Wrapping`, email: id.email, phone: id.phoneNormalized });
    const name = `${TAG} Responsive Media ${width}`;
    let failNext = true;
    await page.route("**/api/finance/onboarding", async (route) => {
      if (route.request().method() === "POST" && failNext) {
        failNext = false;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong." }) });
      }
      return route.continue();
    });

    await openNewAgreement(page);
    await expectNoOverflow(page, width, "agreement-for");
    await radio(page, /^Instagram \+ YouTube Partner/).click();
    await radio(page, /^Create new Partner from Agreement/).click();
    await expect(page.getByTestId("section-onboarding-upload")).toBeVisible();
    await expectNoOverflow(page, width, "upload (empty)");

    await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }, "a-rather-long-signed-agreement-file-name-for-wrapping-checks.pdf"));
    await expectNoOverflow(page, width, "extracted + proposed record");
    if (width === 390) await shotEl(page.getByTestId("intake-onboarding"), "34-wizard-390-extracted-and-record");

    await fillAccount(page, "YouTube", `https://www.youtube.com/@${id.ytHandle}`);
    await checkDuplicates(page, "Partner");
    await expect(page.getByTestId(`onboarding-candidate-${existing.partnerRef}`)).toBeVisible();
    await expectNoOverflow(page, width, "duplicate candidates");
    await page.getByTestId("onboarding-continue-new").click();
    await page.getByTestId("onboarding-acknowledge").getByRole("checkbox").check();
    await page.getByTestId("onboarding-acknowledge").getByLabel(/^Reason for creating a new Partner/).fill("A different business that shares the same mailbox.");
    await expectNoOverflow(page, width, "acknowledgement");
    await createButton(page).click();
    await expect(page.getByTestId("onboarding-lost")).toBeVisible();
    await expectNoOverflow(page, width, "failure + Retry");
    if (width === 390) {
      await shotEl(page.getByTestId("section-onboarding-create"), "35-wizard-390-failure-retry");
      await shotEl(page.getByTestId("section-onboarding-duplicates"), "36-wizard-390-duplicates");
    }
    await page.getByTestId("onboarding-retry").click();
    await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
    await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
    await expectNoOverflow(page, width, "after create (intake continues)");
    expect(errors.errors).toEqual([]);
  });
}

test("DEEP LINK: ?counterpartyType=VENDOR&mode=new opens the Vendor wizard directly; a Partner deep link still asks for the platform choice (never guessed)", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openNewAgreement(page, "?counterpartyType=VENDOR&mode=new");
  await expect(radio(page, /^Vendor/)).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, /^Create new Vendor from Agreement/)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("section-onboarding-upload")).toBeVisible();
  await openNewAgreement(page, "?counterpartyType=PARTNER&mode=new");
  await expect(page.getByTestId("section-onboarding-upload")).toHaveCount(0);
  for (const name of [/^Instagram Partner/, /^YouTube Partner/, /^Instagram \+ YouTube Partner/]) await expect(radio(page, name)).toHaveAttribute("aria-checked", "false");
  await radio(page, /^YouTube Partner/).click();
  await expect(radio(page, /^Create new Partner from Agreement/)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("section-onboarding-upload")).toBeVisible();
  await expect(page.getByTestId("onboarding-account-youtube")).toHaveCount(0); // rows appear once the Agreement is read
  expect(errors.errors).toEqual([]);
});

test("PLATFORM + SCOPE guards: an Instagram link in a YouTube-Partner Agreement is never silently used as the YouTube account; a region OUTSIDE the person's scope is refused with a plain reason before anything is written", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("guards");
  const name = `${TAG} Guards Media`;
  await signInAs(page, "manager");
  await openWizard(page, "YOUTUBE_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, state: "Karnataka", pageLink: `https://www.instagram.com/${id.handle}/` }));
  // the Instagram page is not placed in the YouTube row; the person is told why
  await expect(page.getByTestId("onboarding-account-youtube").getByLabel(/^YouTube page link/)).toHaveValue("");
  await expect(page.locator('[aria-label="Notes about the prefilled details"]')).toContainText("looks like a Instagram page, but this Agreement is for YouTube");
  await page.getByTestId("onboarding-account-youtube").getByLabel(/^YouTube page link/).fill(`https://www.youtube.com/@${id.ytHandle}`);
  // Karnataka is not in the Manager's scope: the server refuses (validate first), nothing is created, and the plain reason says what to do
  await checkDuplicates(page, "Partner");
  await createButton(page).click();
  const refused = page.getByTestId("onboarding-refused");
  await expect(refused).toContainText("Nothing was created.");
  await expect(refused).toContainText("Choose a region you have access to");
  await expect(page.getByTestId("onboarding-steps")).toHaveCount(0);
  expect((await partnersNamed(name)).length).toBe(0);
  expect(await counts(name, id.email)).toEqual({ partners: 0, accounts: 0, agreements: 0 });
  // the inputs are editable again: choosing a region in scope succeeds
  await field(page, /^State \/ region/).selectOption("Kerala");
  await checkDuplicates(page, "Partner");
  await createButton(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  expect((await partnersNamed(name)).length).toBe(1);
  expect(errors.errors).toEqual([]);
});
