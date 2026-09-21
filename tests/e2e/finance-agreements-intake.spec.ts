import { expect as baseExpect, test, type Page } from "@playwright/test";

import {
  collectBrowserErrors,
  collectResponseBodies,
  createFinanceFixtures,
  leaked,
  PDFS,
  SAMPLE_PDF_NAME,
  SENSITIVE_STRINGS,
  signInAs,
  waitForHydration,
  type FinanceFixtures,
} from "./helpers/finance-agreements-fixtures";
import { financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { partnersCollection } from "@/server/partners/firestore";
import { vendorsCollection } from "@/server/vendors/firestore";

// Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default for a UI outcome.
const expect = baseExpect.configure({ timeout: 15_000 });

// Step 14B e2e: Agreement intake - the four `Agreement for` choices, the authorized Partner / Vendor search, Partner Account selection,
// Vendor selection, draft creation + resume, the contract upload / extraction flow and the existing-CreatorOps-data preload.
// Hermetic: private-region fixtures, unique tag, everything (including what the browser flows created) removed in afterAll.

test.describe.configure({ mode: "serial" });

const TAG = `FAI${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);

const N = {
  twoIg: `${TAG} Twin Instagram`,
  both: `${TAG} Both Platforms`,
  solo: `${TAG} Solo Instagram`,
  yt: `${TAG} Only YouTube`,
  hidden: `${TAG} Hidden Partner`,
  vendor: `${TAG} Sample Vendor`,
  hiddenVendor: `${TAG} Hidden Vendor`,
};
const P: Record<string, { partnerRef: string; accounts: Record<string, string> }> = {};
let vendorRef = "";

async function heads(counterpartyUid: string, field: "partnerUid" | "vendorUid") {
  return (await financeAgreementsCollection().where(field, "==", counterpartyUid).get()).docs.map((doc) => doc.data());
}

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  const twin = await fx.seedPartner({ displayName: N.twoIg, email: "twin@example.test", phone: "+91 90000 11111" });
  const a1 = await fx.seedAccount(twin, "instagram", { handle: "twin_main", primary: true });
  const a2 = await fx.seedAccount(twin, "instagram", { handle: "twin_backup" });
  const a3 = await fx.seedAccount(twin, "youtube", { handle: "twin_channel" });
  P.twoIg = { partnerRef: twin.partnerRef, accounts: { igMain: a1.partnerAccountRef, igBackup: a2.partnerAccountRef, yt: a3.partnerAccountRef } };
  await fx.fullKyc(fx.partnerSubject(twin));

  const both = await fx.seedPartner({ displayName: N.both });
  const b1 = await fx.seedAccount(both, "instagram", { handle: "both_ig", primary: true });
  const b2 = await fx.seedAccount(both, "youtube", { handle: "both_yt", primary: true });
  P.both = { partnerRef: both.partnerRef, accounts: { ig: b1.partnerAccountRef, yt: b2.partnerAccountRef } };

  const solo = await fx.seedPartner({ displayName: N.solo });
  const s1 = await fx.seedAccount(solo, "instagram", { handle: "solo_ig", primary: true });
  P.solo = { partnerRef: solo.partnerRef, accounts: { ig: s1.partnerAccountRef } };

  const yt = await fx.seedPartner({ displayName: N.yt });
  const y1 = await fx.seedAccount(yt, "youtube", { handle: "yt_only", primary: true });
  P.yt = { partnerRef: yt.partnerRef, accounts: { yt: y1.partnerAccountRef } };

  const hidden = await fx.seedPartner({ displayName: N.hidden, regionIds: [fx.hiddenRegion] });
  P.hidden = { partnerRef: hidden.partnerRef, accounts: {} };

  vendorRef = (await fx.seedVendor({ displayName: N.vendor })).vendorRef;
  await fx.seedVendor({ displayName: N.hiddenVendor, regionIds: [fx.hiddenRegion] });
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const choice = (page: Page, name: string | RegExp) => page.getByRole("radio", { name });
const startDraft = (page: Page) => page.getByTestId("start-draft");

async function openNew(page: Page, query = "") {
  await page.goto(`/finance/agreements/new${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "New Agreement" })).toBeVisible();
  await waitForHydration(page, '[role="radio"]');
}

async function pickCounterparty(page: Page, noun: "Partner" | "Vendor", name: string) {
  const box = page.getByRole("combobox", { name: `Search ${noun}` });
  await box.click();
  await box.fill(name);
  const option = page.getByRole("option", { name });
  await expect(option).toBeVisible();
  await option.click();
  await expect(box).toHaveValue(name);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
test("the form has ten sections in the specified order and the first choice offers exactly four options, nothing else selectable", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openNew(page);
  // before a draft exists: Agreement for + Existing details + a note about what opens later
  await expect(page.getByRole("heading", { level: 2, name: "Agreement for" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Existing CreatorOps details" })).toBeVisible();
  const radios = page.getByRole("radiogroup").first().getByRole("radio");
  await expect(radios).toHaveText([/Instagram Partner/, /YouTube Partner/, /Instagram \+ YouTube Partner/, /Vendor/]);
  await expect(startDraft(page)).toBeDisabled();
  await expect(page.getByText("Contract source, Cross-verification, Commercial terms, Performance targets, KYC and Review open once the draft is started.")).toBeVisible();
  // no counterparty box until a choice is made
  await expect(page.getByRole("combobox")).toHaveCount(0);
  expect(errors.errors).toEqual([]);
});

test("Partner platform choices map to ONE canonical Partner: choosing Instagram, YouTube or both never creates a separate entity and Account-specific drafts derive the platform scope", async ({ page }) => {
  const partnersBefore = (await partnersCollection().where("displayName", "==", N.both).get()).size;
  await openNew(page);
  await choice(page, /^Instagram \+ YouTube Partner/).click();
  await pickCounterparty(page, "Partner", N.both);
  await expect(page.getByText("Loading this Partner's accounts…")).toHaveCount(0);
  // the distinction is explicit: two scope cards
  await expect(choice(page, /^Account-specific/)).toBeVisible();
  await expect(choice(page, /^Partner-level/)).toBeVisible();
  await choice(page, /^Account-specific/).click();
  // one account group per selected platform; the single eligible account of each is suggested but visible / changeable
  await expect(page.getByRole("radiogroup", { name: "Instagram account" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "YouTube account" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Instagram account" }).getByRole("radio", { checked: true })).toContainText("@both_ig");
  await expect(page.getByRole("radiogroup", { name: "YouTube account" }).getByRole("radio", { checked: true })).toContainText("@both_yt");
  await startDraft(page).click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}&version=1/);
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();

  const stored = await heads(P.both!.partnerRef, "partnerUid");
  expect(stored).toHaveLength(1);
  const counterparty = stored[0]!.counterparty as { type: string; partnerRef: string; partnerAccountRefs: string[]; platformScope: string[] };
  expect(counterparty.type).toBe("PARTNER");
  expect(counterparty.partnerRef).toBe(P.both!.partnerRef);
  expect([...counterparty.partnerAccountRefs].sort()).toEqual([P.both!.accounts.ig, P.both!.accounts.yt].sort());
  expect([...counterparty.platformScope].sort()).toEqual(["instagram", "youtube"]);
  // still exactly ONE Partner with that name - no per-platform entities
  expect((await partnersCollection().where("displayName", "==", N.both).get()).size).toBe(partnersBefore);
  // the locked summary says what the draft is
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Instagram + YouTube Partner");
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Account-specific");
});

test("Instagram Partner and YouTube Partner choices show only the accounts of THEIR platform; a Partner without an active account there cannot be Account-specific", async ({ page }) => {
  await openNew(page);
  await choice(page, /^Instagram Partner/).click();
  await pickCounterparty(page, "Partner", N.solo);
  await choice(page, /^Account-specific/).click();
  await expect(page.getByRole("radiogroup", { name: "Instagram account" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "YouTube account" })).toHaveCount(0);

  // switching to YouTube keeps the Partner but the account picks are dropped; Solo has no YouTube account
  await choice(page, /^YouTube Partner/).click();
  await expect(page.getByRole("combobox", { name: "Search Partner" })).toHaveValue(N.solo);
  await choice(page, /^Account-specific/).click();
  await expect(page.getByRole("alert").filter({ hasText: /no active YouTube account/ })).toBeVisible();
  await expect(startDraft(page)).toBeDisabled();
  // Partner-level is still possible: it records the intended platform instead of naming an account
  await choice(page, /^Partner-level/).click();
  await expect(page.getByText(/Partner-level: no Partner Account is named/)).toBeVisible();
  await expect(startDraft(page)).toBeEnabled();
});

test("search is authorized: only Partners in the actor's scope are listed (a hidden-region Partner never appears for a scoped Manager), results carry display identity only", async ({ page }) => {
  await signInAs(page, "manager");
  const bodies = collectResponseBodies(page);
  await openNew(page);
  await choice(page, /^Instagram Partner/).click();
  const box = page.getByRole("combobox", { name: "Search Partner" });
  await box.click();
  await box.fill(TAG);
  await expect(page.getByRole("option", { name: N.solo })).toBeVisible();
  await expect(page.getByRole("option", { name: N.twoIg })).toBeVisible();
  await expect(page.getByRole("option", { name: N.hidden })).toHaveCount(0);
  await box.fill(N.hidden);
  await expect(page.getByText("No matching Partners in your authorized scope")).toBeVisible();
  const searchBodies = bodies.bodies.filter((entry) => entry.url.includes("/api/finance/counterparties/search"));
  expect(searchBodies.length).toBeGreaterThan(0);
  for (const entry of searchBodies) {
    expect(entry.text).not.toContain(N.hidden);
    const json = JSON.parse(entry.text) as { results: Array<Record<string, unknown>> };
    for (const result of json.results) expect(Object.keys(result).sort()).toEqual(["displayName", "ref", "regions", "status", "type"].sort());
    expect(entry.text).not.toMatch(/email|phone|example\.test/);
  }
  // Vendor search likewise
  await choice(page, /^Vendor/).click();
  const vbox = page.getByRole("combobox", { name: "Search Vendor" });
  await vbox.click();
  await vbox.fill(TAG);
  await expect(page.getByRole("option", { name: N.vendor })).toBeVisible();
  await expect(page.getByRole("option", { name: N.hiddenVendor })).toHaveCount(0);
  // the Super Admin (global scope) does see the hidden Partner
  await signInAs(page, "admin");
  await openNew(page);
  await choice(page, /^Instagram Partner/).click();
  const abox = page.getByRole("combobox", { name: "Search Partner" });
  await abox.click();
  await abox.fill(N.hidden);
  await expect(page.getByRole("option", { name: N.hidden })).toBeVisible();
});

test("two accounts on one platform require a deliberate choice: nothing is preselected, Start draft stays disabled with the reason, then the chosen account (and only it) goes on the draft", async ({ page }) => {
  await openNew(page);
  await choice(page, /^Instagram \+ YouTube Partner/).click();
  await pickCounterparty(page, "Partner", N.twoIg);
  await choice(page, /^Account-specific/).click();
  const ig = page.getByRole("radiogroup", { name: "Instagram account" });
  await expect(ig).toBeVisible();
  await expect(page.getByText("This Partner has 2 Instagram accounts. Choose the one this Agreement covers.")).toBeVisible();
  await expect(ig.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(ig.getByRole("radio")).toHaveCount(2);
  await expect(startDraft(page)).toBeDisabled();
  // the sole YouTube account is suggested
  await expect(page.getByRole("radiogroup", { name: "YouTube account" }).getByRole("radio", { checked: true })).toContainText("@twin_channel");
  // never chosen by display name alone: each option leads with its handle
  await expect(ig.getByRole("radio").first()).toContainText("@twin_");
  await ig.getByRole("radio", { name: /twin_backup/ }).click();
  await expect(startDraft(page)).toBeEnabled();
  await startDraft(page).click();
  await expect(page).toHaveURL(/agreementRef=agr_/);
  const stored = await heads(P.twoIg!.partnerRef, "partnerUid");
  expect(stored).toHaveLength(1);
  const cp = stored[0]!.counterparty as { partnerAccountRefs: string[]; platformScope: string[] };
  expect([...cp.partnerAccountRefs].sort()).toEqual([P.twoIg!.accounts.igBackup, P.twoIg!.accounts.yt].sort());
  expect(cp.partnerAccountRefs).not.toContain(P.twoIg!.accounts.igMain);
});

test("Partner-level draft: no account is named, the intended platforms are RECORDED on the draft, the distinction is stated", async ({ page }) => {
  await openNew(page);
  await choice(page, /^Instagram Partner/).click();
  await pickCounterparty(page, "Partner", N.yt);
  await choice(page, /^Partner-level/).click();
  await expect(page.getByText(/no Partner Account is named/)).toBeVisible();
  await startDraft(page).click();
  await expect(page).toHaveURL(/agreementRef=agr_/);
  const stored = await heads(P.yt!.partnerRef, "partnerUid");
  expect(stored).toHaveLength(1);
  const cp = stored[0]!.counterparty as { partnerAccountRefs: string[]; platformScope: string[] };
  expect(cp.partnerAccountRefs).toEqual([]);
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Partner-level");
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Platforms recorded");
  await expect(page.getByTestId("intake-agreement_for")).toContainText(/Instagram/i);
});

test("Vendor selection: canonical Vendor identity only, a represented Partner is never inferred; the draft is a Vendor Agreement", async ({ page }) => {
  await openNew(page);
  await choice(page, /^Vendor/).click();
  await pickCounterparty(page, "Vendor", N.vendor);
  await expect(page.getByText(/A Partner the Vendor may represent is not inferred/)).toBeVisible();
  // no Partner Account / scope controls for a Vendor
  await expect(choice(page, /^Account-specific/)).toHaveCount(0);
  await startDraft(page).click();
  await expect(page).toHaveURL(/agreementRef=agr_/);
  const vendor = (await vendorsCollection().where("vendorRef", "==", vendorRef).get()).docs[0]!.data();
  const stored = await heads(vendor.uid as string, "vendorUid");
  expect(stored).toHaveLength(1);
  expect((stored[0]!.counterparty as { type: string }).type).toBe("VENDOR");
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Vendor Agreement");
  await expect(page.getByTestId("intake-existing_details")).toContainText(N.vendor);
});

test("draft creation is idempotent and resumable: a double click makes ONE Agreement, the URL carries the draft, a reload resumes it, the counterparty is locked", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openNew(page);
  await choice(page, /^Instagram Partner/).click();
  await pickCounterparty(page, "Partner", N.solo);
  await choice(page, /^Account-specific/).click();
  await expect(startDraft(page)).toBeEnabled();
  await startDraft(page).dblclick();
  await expect(page).toHaveURL(/agreementRef=agr_[0-9a-f]{20}&version=1/);
  const ref = new URL(page.url()).searchParams.get("agreementRef")!;
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
  expect(await heads(P.solo!.partnerRef, "partnerUid")).toHaveLength(1);
  // the pressed button is gone (the form remounts on the draft): focus moves DELIBERATELY to the next section and a polite message announces it
  await expect(page.getByTestId("intake-status")).toContainText("Draft created. The counterparty is now fixed. Continue with Contract source.");
  await expect(page.getByRole("heading", { level: 2, name: "Contract source" })).toBeFocused();

  // the ten sections, in order
  const sections = ["Agreement for", "Contract source", "Existing CreatorOps details", "Extracted from Agreement", "Cross-verification", "Commercial terms", "Performance targets", "KYC & restricted details", "Additional details", "Review & confirm"];
  await expect(page.locator("form h2").filter({ hasText: /^(Agreement for|Contract source|Existing CreatorOps details|Extracted from Agreement|Cross-verification|Commercial terms|Performance targets|KYC & restricted details|Additional details|Review & confirm)/ })).toHaveText(sections.map((title) => new RegExp(`^${title.replace(/[&+]/g, "\\$&")}`)));

  // reload resumes the same draft
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`agreementRef=${ref}`));
  await expect(page.getByTestId("intake-agreement_for")).toContainText(ref);
  await expect(page.getByTestId("intake-agreement_for")).toContainText("Partner");
  await expect(page.getByRole("combobox", { name: "Search Partner" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start a new draft" })).toHaveAttribute("href", "/finance/agreements/new");
  // a forged / unknown agreementRef is ONE neutral not-found
  await page.goto("/finance/agreements/new?agreementRef=agr_00000000000000000000&version=1");
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  expect(errors.errors).toEqual([]);
});

test("a deep link from a Partner page preselects the counterparty (nothing else is echoed); an out-of-scope ref starts the form empty", async ({ page }) => {
  await openNew(page, `?counterpartyType=PARTNER&ref=${encodeURIComponent(P.yt!.partnerRef)}`);
  await choice(page, /^YouTube Partner/).click();
  await expect(page.getByRole("combobox", { name: "Search Partner" })).toHaveValue(N.yt);
  await expect(page.getByTestId("existing-details")).toContainText(N.yt);
  await signInAs(page, "manager");
  await openNew(page, `?counterpartyType=PARTNER&ref=${encodeURIComponent(P.hidden!.partnerRef)}`);
  await expect(page.getByTestId("existing-details")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(N.hidden);
});

// ---- Contract source ---------------------------------------------------------------------------------------------------------------------
test.describe("contract upload and extraction", () => {
  let draftRef = "";
  let draftPartner = "";

  test.beforeAll(async () => {
    const partner = await fx.seedPartner({ displayName: `${TAG} Extraction Partner`, email: "someone-else@example.test", phone: null });
    draftPartner = partner.partnerRef;
    draftRef = (await fx.newDraft(fx.partnerCp(partner))).head.agreementRef;
  });

  const openDraft = async (page: Page) => {
    await page.goto(`/finance/agreements/new?agreementRef=${draftRef}&version=1`);
    await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
    await waitForHydration(page, 'input[type="file"]');
  };
  const pick = (page: Page, name: string, buffer: Buffer, mimeType = "application/pdf") => page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  const section = (page: Page) => page.getByTestId("intake-contract_source");

  test("copy, PDF-only accept, max 10 MB and the review note are stated; Extract stays disabled until a file is chosen", async ({ page }) => {
    await openDraft(page);
    await expect(section(page)).toContainText("Upload signed Agreement to extract and cross-check details");
    await expect(section(page)).toContainText("PDF only · up to 10 MB");
    await expect(section(page)).toContainText("Extraction suggests values only. Review every field before confirming the Agreement.");
    await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", /pdf/);
    await expect(page.getByTestId("extract-from-agreement")).toBeDisabled();
    await expect(section(page)).not.toContainText(/OCR|legally verified|verified legally/i);
  });

  test("a file over 10 MB and a non-PDF are refused in the browser with a clear reason and nothing is uploaded", async ({ page }) => {
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/finance/contracts/upload")) uploads.push(request.url());
    });
    await openDraft(page);
    await pick(page, "huge.pdf", PDFS.oversize());
    await expect(section(page).getByRole("alert")).toContainText(/10 MB/);
    await expect(page.getByTestId("extract-from-agreement")).toBeDisabled();
    await expect(page.getByTestId("selected-file")).toHaveCount(0);
    await pick(page, "notes.txt", PDFS.notPdf(), "text/plain");
    await expect(section(page).getByRole("alert")).toContainText(/PDF/);
    await expect(page.getByTestId("extract-from-agreement")).toBeDisabled();
    expect(uploads).toEqual([]);
  });

  test("the server is the truth for content: a .pdf that is not a PDF is rejected without echoing the bytes", async ({ page }) => {
    await openDraft(page);
    await pick(page, "disguised.pdf", PDFS.notPdf(), "application/pdf");
    await expect(page.getByTestId("selected-file")).toContainText("disguised.pdf");
    await page.getByTestId("extract-from-agreement").click();
    await expect(page.getByTestId("intake-errors")).toContainText(/not a valid PDF|not a PDF/i);
    await expect(page.getByTestId("extraction-result")).toHaveCount(0);
  });

  test("a scan / no-text PDF ends in the manual-review state: 'Manual review required — no extractable text was found.'", async ({ page }) => {
    await openDraft(page);
    await pick(page, "scanned-agreement.pdf", PDFS.scan());
    await page.getByTestId("extract-from-agreement").click();
    await expect(page.getByTestId("extraction-status-chip")).toHaveText("Manual review required");
    await expect(page.getByTestId("extraction-result")).toContainText("Manual review required — no extractable text was found.");
    await expect(page.getByTestId("extraction-status")).toContainText("Manual review required — no extractable text was found.");
    // nothing to attach, nothing proposed, no OCR promise
    await expect(page.getByTestId("attach-extracted")).toHaveCount(0);
    await expect(page.getByTestId("intake-extracted")).toContainText(/No values could be proposed|Nothing has been extracted/);
    await expect(section(page)).not.toContainText(/OCR/i);
  });

  test("a malformed PDF is not a crash: a neutral result or error, the draft stays usable", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await openDraft(page);
    await pick(page, "broken.pdf", PDFS.malformed());
    await page.getByTestId("extract-from-agreement").click();
    // either MANUAL_REVIEW_REQUIRED (unreadable) or an error banner - never an unhandled error / blank
    await expect(page.getByTestId("extraction-status-chip").or(page.getByTestId("intake-errors").getByText(/Couldn’t complete/))).toBeVisible();
    await expect(page.getByTestId("save-state")).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("the sample Agreement extracts: status, warnings, proposals in their own section, each 'Needs confirmation', NOTHING accepted or auto-confirmed", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await openDraft(page);
    await pick(page, SAMPLE_PDF_NAME, PDFS.sample());
    await expect(page.getByTestId("selected-file")).toContainText(SAMPLE_PDF_NAME);
    const button = page.getByTestId("extract-from-agreement");
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByTestId("extraction-status-chip")).toHaveText(/^(Extracted|Partial)/i);
    await expect(page.getByTestId("contract-artifact")).toContainText(SAMPLE_PDF_NAME);
    await expect(page.getByTestId("extraction-status")).toContainText(/Extraction finished/);
    // focus moves to the result for keyboard / screen-reader users
    await expect(page.getByTestId("extraction-result")).toBeFocused();

    // proposals live in "Extracted from Agreement", every row "Needs confirmation", nothing says accepted
    const grid = page.getByTestId("extraction-grid");
    await expect(grid).toBeVisible();
    const rowCount = await grid.locator("tbody tr").count();
    expect(rowCount).toBeGreaterThan(5);
    await expect(grid.getByText("Needs confirmation")).toHaveCount(rowCount);
    await expect(grid).toContainText("Counterparty name");
    await expect(grid).not.toContainText(/\bAccepted\b/);
    // BEFORE attach: the draft holds no extraction (source mode still Manual, nothing pending from the Agreement)
    let stored = (await financeAgreementsCollection().doc(draftRef).collection("versions").doc("1").get()).data()!;
    expect(stored.source?.extractionRunRef ?? null).toBeNull();
    expect(stored.confirmation ?? null).toBeNull();

    // attach is a separate explicit click
    await expect(page.getByTestId("attach-extracted")).toBeVisible();
    await page.getByTestId("attach-extracted").click();
    await expect(page.getByTestId("extraction-attached")).toContainText("Attached as pending");
    await expect(page.getByTestId("intake-status")).toContainText(/added to the draft as pending/);
    stored = (await financeAgreementsCollection().doc(draftRef).collection("versions").doc("1").get()).data()!;
    expect(stored.source.extractionRunRef).toMatch(/^run_/);
    // never auto-confirmed and never accepted: every extracted entry is PENDING, the version is not confirmed
    expect(stored.confirmation ?? null).toBeNull();
    const extractedEntries = Object.entries(stored.draft as Record<string, { origin: string; decision: string }>).filter(([, entry]) => entry.origin === "EXTRACTED");
    expect(extractedEntries.length).toBeGreaterThan(3);
    for (const [key, entry] of extractedEntries) expect(entry.decision, key).toBe("PENDING");
    await expect(page.getByTestId("confirm-agreement")).toBeDisabled();
    // the resumed page (reload) still shows the extraction and the attached state
    await page.reload();
    await expect(page.getByTestId("extraction-attached")).toBeVisible();
    await expect(page.getByTestId("extraction-grid")).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("the Partner record is untouched by extraction, attach and Save Draft (no silent master update)", async ({ page }) => {
    const before = (await partnersCollection().doc(draftPartner).get()).data()!;
    await openDraft(page);
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
    const after = (await partnersCollection().doc(draftPartner).get()).data()!;
    expect(after).toEqual(before);
    expect(after.phone).toBeNull();
    expect(after.email).toBe("someone-else@example.test");
  });

  test("a Manager (no contract / identity sensitive access) sees the same proposals but no identity value, no raw contract text - in the page, the DOM and every response", async ({ page }) => {
    await signInAs(page, "manager");
    const bodies = collectResponseBodies(page);
    await openDraft(page);
    await expect(page.getByTestId("extraction-grid")).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(leaked(text)).toEqual([]);
    expect(leaked(await page.content(), SENSITIVE_STRINGS)).toEqual([]);
    for (const body of bodies.bodies) expect(leaked(body.text), `${body.url} leaked`).toEqual([]);
    // no raw snippet of the contract (Contract text disclosure) for this actor
    await expect(page.getByText("Contract text")).toHaveCount(0);
    expect(text).not.toContain("Account Number:");
    // identity rows are masked
    await expect(page.getByTestId("extraction-grid").getByText(/Restricted/i).first()).toBeVisible();
  });
});

// ---- Existing CreatorOps data ---------------------------------------------------------------------------------------------------------
test("existing CreatorOps data preloads immediately, is labelled 'CreatorOps master data', shows name / phone / email / state / GSTIN status / accounts / KYC status and never invents an address or PIN", async ({ page }) => {
  await openNew(page);
  await choice(page, /^Instagram \+ YouTube Partner/).click();
  await pickCounterparty(page, "Partner", N.twoIg);
  const section = page.getByTestId("intake-existing_details");
  // preloaded BEFORE any draft exists
  await expect(page.getByTestId("existing-details")).toBeVisible();
  await expect(section).toContainText("CreatorOps master data");
  await expect(section).toContainText(N.twoIg);
  await expect(section).toContainText("twin@example.test");
  await expect(section).toContainText("+91 90000 11111");
  await expect(section).toContainText(`${TAG}-region`);
  await expect(section.locator("div", { hasText: /^Address/ }).first()).toContainText("Not available in CreatorOps");
  await expect(section.locator("div", { hasText: /^PIN code/ }).first()).toContainText("Not available in CreatorOps");
  await expect(section.getByRole("list", { name: "Partner Accounts" })).toContainText("@twin_main");
  await expect(section.getByRole("list", { name: "Partner Accounts" })).toContainText("@twin_backup");
  await expect(section.getByRole("list", { name: "Partner Accounts" })).toContainText("@twin_channel");
  await expect(page.getByTestId("existing-kyc-state")).toHaveText("Available");
  await expect(section.getByRole("list", { name: "KYC components" })).toContainText("PAN");
  await expect(section).toContainText("KYC available in Partner/Vendor record");
  // GSTIN as STATUS only
  await expect(section).toContainText("On record");
  // an admin holds the identity category, but the preview is status only: no value, not even for the Super Admin
  expect(leaked(await page.content(), SENSITIVE_STRINGS)).toEqual([]);
});

test("existing data with missing KYC says so and offers nothing to reveal; a Partner without contact data shows the empty state honestly", async ({ page }) => {
  await openNew(page);
  await choice(page, /^Instagram Partner/).click();
  await pickCounterparty(page, "Partner", N.solo);
  await expect(page.getByTestId("existing-kyc-state")).toHaveText(/Missing/);
  await expect(page.getByTestId("intake-existing_details")).not.toContainText("KYC available in Partner/Vendor record");
});
