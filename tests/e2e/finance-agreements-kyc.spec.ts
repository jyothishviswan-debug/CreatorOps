import { test, type Page } from "@playwright/test";

import {
  collectBrowserErrors,
  collectResponseBodies,
  CONTRACT_SENSITIVE,
  createFinanceFixtures,
  leaked,
  noDocumentOverflow,
  renderedDom,
  SECRETS,
  signInAs,
  uniqueIdentity,
  VIEWPORTS,
  type FinanceFixtures,
} from "./helpers/finance-agreements-fixtures";
import { checkDuplicates, expect, extractInWizard, openWizard, pdfFile, shot, shotEl } from "./helpers/finance-onboarding-helpers";
import { getAdminFirestore } from "@/server/firebase/admin";
import { FINANCE_AGREEMENT_COLLECTIONS, financeAgreementsCollection } from "@/server/finance-agreements/firestore";
import { partnersCollection } from "@/server/partners/firestore";
import { restrictedFinancialIdentitiesCollection, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";

// Step 14B.1 e2e: per-COMPONENT KYC in the Agreement intake (existing AND new counterparties). Complete KYC => NO upload action anywhere; one
// missing component => only that component's `Upload / Update`; an incomplete bank => only `Complete bank details`; an actor without the identity
// category sees safe status only. The component-scoped dialog writes ONLY the canonical owning KYC record.
// File-upload evidence is never used here (the owning module's evidence upload talks to REAL Google Drive): only evidence LINKS and the
// apply-from-Agreement command are exercised, and any multipart evidence request is aborted defensively.

test.describe.configure({ mode: "serial" });

const TAG = `FKY${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);

type Seeded = { partnerUid: string; partnerRef: string; agreementRef: string };
const S: Record<string, Seeded> = {};
const V: Record<string, { vendorUid: string; vendorRef: string; agreementRef: string }> = {};

async function seedPartnerDraft(key: string, kyc: Parameters<FinanceFixtures["seedKyc"]>[1] | null) {
  const partner = await fx.seedPartner({ displayName: `${TAG} ${key}` });
  if (kyc) await fx.seedKyc(fx.partnerSubject(partner), kyc);
  const draft = await fx.seedDraft(fx.partnerCp(partner));
  S[key] = { partnerUid: partner.uid, partnerRef: partner.partnerRef, agreementRef: draft.head.agreementRef };
}

test.beforeAll(async () => {
  await fx.grantFixtureRegion();
  await seedPartnerDraft("Full", { pan: true, aadhaar: true, bank: true, gst: "number" });
  await seedPartnerDraft("PanMissing", { pan: false, aadhaar: true, bank: true, gst: "number", evidence: [] });
  await seedPartnerDraft("BankIncomplete", { pan: true, aadhaar: true, bank: false, gst: "number", evidence: ["bank"] });
  await seedPartnerDraft("Nothing", null);
  const vendor = await fx.seedVendor({ displayName: `${TAG} Vendor Full` });
  await fx.seedKyc(fx.vendorSubject(vendor), { pan: true, bank: true, gst: "number" });
  const draft = await fx.seedDraft(fx.vendorCp(vendor));
  V.Full = { vendorUid: vendor.uid, vendorRef: vendor.vendorRef, agreementRef: draft.head.agreementRef };
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

// Defensive: the owning evidence FILE upload talks to live Drive - a multipart request to it never leaves the browser in these specs.
async function blockEvidenceFileUploads(page: Page): Promise<{ blocked: number }> {
  const bag = { blocked: 0 };
  await page.route(/\/restricted-identity\/evidence/, async (route) => {
    const type = route.request().headers()["content-type"] ?? "";
    if (route.request().method() === "POST" && /multipart/i.test(type)) {
      bag.blocked += 1;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return bag;
}

const openDraft = async (page: Page, agreementRef: string) => {
  await page.goto(`/finance/agreements/new?agreementRef=${agreementRef}&version=1`);
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
  await expect(page.getByTestId("kyc-headline")).toBeVisible();
};
const kycSection = (page: Page) => page.getByTestId("intake-kyc");
const row = (page: Page, component: "pan" | "aadhaar" | "bank" | "gst") => kycSection(page).locator(`[data-kyc-component="${component}"]`);
const actionButtons = (page: Page) => kycSection(page).getByRole("button", { name: /Upload \/ Update|Complete bank details/ });

// ---------------------------------------------------------------------------------------------------------------------------------------
test("COMPLETE KYC: every component is Available, there is NO upload action anywhere in the section, and it says `KYC available in Partner/Vendor record`", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openDraft(page, S.Full!.agreementRef);
  await expect(page.getByTestId("kyc-headline")).toHaveText(/KYC available in Partner\/Vendor record/);
  for (const component of ["pan", "aadhaar", "bank", "gst"] as const) {
    await expect(row(page, component)).toHaveAttribute("data-kind", "available");
    await expect(row(page, component)).toContainText("Available");
  }
  await expect(actionButtons(page)).toHaveCount(0);
  await expect(kycSection(page).getByRole("button", { name: /upload/i })).toHaveCount(0);
  await expect(page.getByTestId("kyc-attention")).toHaveCount(0);
  await shotEl(kycSection(page), "16-kyc-complete");
  // no upload / KYC dialog trigger elsewhere on the whole page
  await expect(page.getByRole("button", { name: /Upload \/ Update/ })).toHaveCount(0);
  expect(errors.errors).toEqual([]);
});

test("ONLY PAN MISSING: only the PAN row offers `Upload / Update`; Aadhaar, Bank and GST are Available with no action", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openDraft(page, S.PanMissing!.agreementRef);
  await expect(row(page, "pan")).toHaveAttribute("data-kind", "missing");
  await expect(row(page, "pan").getByRole("button", { name: /Upload \/ Update/ })).toBeVisible();
  for (const component of ["aadhaar", "bank", "gst"] as const) {
    await expect(row(page, component)).toHaveAttribute("data-kind", "available");
    await expect(row(page, component).getByRole("button")).toHaveCount(0);
  }
  await expect(actionButtons(page)).toHaveCount(1);
  await expect(page.getByTestId("kyc-attention")).toHaveText("PAN needs attention.");
  await expect(page.getByTestId("kyc-headline")).not.toHaveText(/KYC available in Partner\/Vendor record/);
  await shotEl(kycSection(page), "17-kyc-only-pan-missing");
  expect(errors.errors).toEqual([]);
});

test("INCOMPLETE BANK (bank document on file, details not entered): only Bank offers an action and it reads `Complete bank details`", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openDraft(page, S.BankIncomplete!.agreementRef);
  await expect(row(page, "bank")).toHaveAttribute("data-kind", "incomplete");
  await expect(row(page, "bank")).toContainText("Incomplete");
  await expect(row(page, "bank")).toContainText("A document is on file");
  await expect(row(page, "bank").getByRole("button", { name: /Complete bank details/ })).toBeVisible();
  for (const component of ["pan", "aadhaar", "gst"] as const) await expect(row(page, component).getByRole("button")).toHaveCount(0);
  await expect(actionButtons(page)).toHaveCount(1);
  await shotEl(kycSection(page), "18-kyc-incomplete-bank");
  expect(errors.errors).toEqual([]);
});

test("NOTHING ON FILE (Partner): all four components are Missing and each has its own action; a Vendor has no Aadhaar row at all", async ({ page }) => {
  await openDraft(page, S.Nothing!.agreementRef);
  for (const component of ["pan", "aadhaar", "bank", "gst"] as const) {
    await expect(row(page, component)).toHaveAttribute("data-kind", "missing");
    await expect(row(page, component).getByRole("button", { name: /Upload \/ Update/ })).toBeVisible();
  }
  await expect(page.getByTestId("kyc-attention")).toHaveText("PAN, Aadhaar, Bank details and GST certificate need attention.");
  await openDraft(page, V.Full!.agreementRef);
  await expect(kycSection(page).locator('[data-kyc-component="aadhaar"]')).toHaveCount(0);
  await expect(actionButtons(page)).toHaveCount(0);
  await expect(page.getByTestId("kyc-headline")).toHaveText(/KYC available in Partner\/Vendor record/);
});

test("UNAUTHORIZED actor (Manager: no identity category): safe status only - no component detail, no action, no value anywhere in the page, the DOM or the network", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const bodies = collectResponseBodies(page);
  await signInAs(page, "manager");
  await openDraft(page, S.PanMissing!.agreementRef);
  await expect(page.getByText("You can see the overall KYC status only. Component detail and uploads need KYC access.")).toBeVisible();
  for (const component of ["pan", "aadhaar", "bank", "gst"] as const) {
    await expect(row(page, component)).toHaveAttribute("data-kind", "restricted");
    await expect(row(page, component)).toContainText("Restricted");
  }
  await expect(actionButtons(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Upload \/ Update|Complete bank details/ })).toHaveCount(0);
  const dom = await renderedDom(page);
  expect(leaked(dom)).toEqual([]);
  expect(leaked(await page.locator("body").innerText())).toEqual([]);
  for (const body of bodies.bodies) expect(leaked(body.text), body.url).toEqual([]);
  await shotEl(kycSection(page), "19-kyc-manager-safe-status");
  expect(errors.errors).toEqual([]);
});

test("COMPONENT-SCOPED DIALOG: `Upload / Update` for PAN opens a dialog for PAN only; adding an evidence LINK updates the canonical owning KYC record and nothing under any financeAgreements* document carries an identity value", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const blocked = await blockEvidenceFileUploads(page);
  await openDraft(page, S.PanMissing!.agreementRef);
  const trigger = row(page, "pan").getByRole("button", { name: /Upload \/ Update/ });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Upload / Update KYC: PAN" })).toBeVisible();
  // scoped to THIS component: no Aadhaar / Bank / GST wording inside it
  await expect(dialog).not.toContainText("Aadhaar");
  await expect(dialog).not.toContainText("GST certificate");
  await expect(dialog.getByRole("link", { name: /Open the Partner record/ })).toHaveAttribute("href", `/partners/${S.PanMissing!.partnerRef}`);
  await shot(page, "20-kyc-component-dialog", { fullPage: false });

  const link = "https://example.test/evidence/pan-document";
  await dialog.getByLabel("PAN document link").fill(link);
  await dialog.getByRole("button", { name: "Add link" }).click();
  await expect(dialog).toHaveCount(0);

  // the canonical owning record now carries a `pan` evidence link, and no PAN value was invented
  const canonical = (await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", S.PanMissing!.partnerUid)).get()).data()!;
  expect((canonical.evidence as Array<{ docType: string; url: string }>).some((item) => item.docType === "pan" && item.url === link)).toBe(true);
  expect(canonical.pan ?? null).toBeNull();
  // the status was re-read: a document is on file for PAN now -> Incomplete (still completable), everything else unchanged
  await expect(row(page, "pan")).toHaveAttribute("data-kind", "incomplete", { timeout: 20_000 });
  await expect(actionButtons(page)).toHaveCount(1);

  // FINANCE holds no copy: neither a seeded canonical identity value nor the evidence link is under any financeAgreements* document
  const finance = await financeDocsText();
  for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account, SECRETS.ifsc, SECRETS.gst, SECRETS.holder, SECRETS.bankName, link]) expect(finance, `finance docs contain ${secret}`).not.toContain(secret);
  expect(blocked.blocked).toBe(0);
  expect(errors.errors).toEqual([]);
});

// Every document (and subcollection document) under EVERY financeAgreements* collection except the restricted extraction store, as one string.
async function financeDocsText(options: { includeRestrictedExtractions?: boolean } = {}): Promise<string> {
  const chunks: string[] = [];
  const walk = async (collection: FirebaseFirestore.CollectionReference) => {
    for (const doc of (await collection.get()).docs) {
      chunks.push(JSON.stringify(doc.data()));
      for (const sub of await doc.ref.listCollections()) await walk(sub);
    }
  };
  for (const name of Object.values(FINANCE_AGREEMENT_COLLECTIONS)) {
    if (!options.includeRestrictedExtractions && /restricted/i.test(name)) continue;
    await walk(getAdminFirestore().collection(name));
  }
  return chunks.join("\n");
}

test("NEW COUNTERPARTY KYC: after a Partner is created from the Agreement its KYC is collected through the CANONICAL services (Apply from Agreement writes the owning KYC record); Finance keeps status only", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const id = uniqueIdentity("newkyc");
  const name = `${TAG} New KYC Partner`;
  await openWizard(page, "INSTAGRAM_PARTNER");
  await extractInWizard(page, pdfFile({ name, email: id.email, phone: id.phone, pageLink: `https://www.instagram.com/${id.handle}/` }));
  await checkDuplicates(page, "Partner");
  await page.getByTestId("onboarding-create").click();
  await expect(page).toHaveURL(/\/finance\/agreements\/new\?agreementRef=agr_[0-9a-f]{20}/);
  await expect(page.getByTestId("kyc-headline")).toBeVisible();
  // the file was re-uploaded / extracted / attached by the hand-off: PROPOSALS exist, nothing decided
  await expect(page.getByTestId("cross-verification-identity")).toBeVisible({ timeout: 40_000 });

  const partner = (await partnersCollection().where("displayName", "==", name).get()).docs[0]!.data();
  // a brand-new Partner has NO KYC record: every component is missing, each with its own action
  for (const component of ["pan", "aadhaar", "bank", "gst"] as const) await expect(row(page, component)).toHaveAttribute("data-kind", "missing");
  expect((await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid)).get()).exists).toBe(false);
  await shotEl(kycSection(page), "21-kyc-new-partner-all-missing");
  const agreementRef = (await financeAgreementsCollection().where("partnerUid", "==", partner.uid).get()).docs[0]!.id;
  await expect.poll(async () => Object.values(((await financeAgreementsCollection().doc(agreementRef).collection("versions").doc("1").get()).data()?.draft ?? {}) as Record<string, { decision: string }>).filter((entry) => entry.decision === "PENDING").length, { timeout: 40_000 }).toBeGreaterThan(3);
  await page.waitForTimeout(2500);
  await shotEl(page.getByTestId("cross-verification-identity"), "22-cross-verification-identity-new-partner");

  // the reviewer acknowledges the PAN found in the Agreement (a decision only - no value is copied into the Agreement) ...
  await page.getByRole("button", { name: "Use Agreement value for PAN number" }).click();
  await expect(page.getByRole("button", { name: "Use Agreement value for PAN number" })).toHaveAttribute("aria-pressed", "true");
  // ... then applies it to the CANONICAL Partner KYC record from the component-scoped dialog
  await row(page, "pan").getByRole("button", { name: /Upload \/ Update/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Apply from Agreement" })).toBeEnabled({ timeout: 20_000 });
  await shot(page, "23-kyc-apply-from-agreement-dialog", { fullPage: false });
  await dialog.getByRole("button", { name: "Apply from Agreement" }).click();
  await expect(dialog).toHaveCount(0);

  const canonical = (await restrictedFinancialIdentitiesCollection().doc(restrictedIdentityDocId("PARTNER", partner.uid)).get()).data()!;
  expect(canonical.pan?.number).toBe(CONTRACT_SENSITIVE.pan);
  expect(canonical.bank ?? null).toBeNull(); // bank details are never applied from a contract
  await expect(row(page, "pan")).toHaveAttribute("data-kind", "available", { timeout: 20_000 });
  await expect(row(page, "pan").getByRole("button")).toHaveCount(0);
  // the other components still need their own action
  await expect(row(page, "bank")).toHaveAttribute("data-kind", "missing");
  // Finance keeps STATUS only: the PAN is in no Finance document except the restricted extraction store, and the page never prints it in full
  const finance = await financeDocsText();
  expect(finance).not.toContain(CONTRACT_SENSITIVE.pan);
  expect(await renderedDom(page)).not.toContain(CONTRACT_SENSITIVE.pan);
  expect(JSON.stringify((await partnersCollection().doc(partner.uid).get()).data())).not.toContain(CONTRACT_SENSITIVE.pan);
  await shotEl(kycSection(page), "24-kyc-new-partner-pan-applied");
  expect(errors.errors).toEqual([]);
});

test("KEYBOARD: the component dialog opens from its button by keyboard, keeps focus inside, closes on Escape and returns focus to the exact button that opened it", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await openDraft(page, S.BankIncomplete!.agreementRef);
  const trigger = row(page, "bank").getByRole("button", { name: /Complete bank details/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Complete bank details" })).toBeVisible();
  // focus moved into the dialog; the page behind it is inert
  await expect.poll(async () => page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    // a native modal <dialog> makes the page behind it inert: Tab can only reach the dialog's own controls (or leave the page to the browser UI, where the active element is <body>) - never a control behind it
    expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest('dialog')), `Tab #${index + 1} reached a control behind the dialog`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // and again with the PAN-missing partner's Upload / Update to prove restore is per opener
  await openDraft(page, S.PanMissing!.agreementRef);
  const pan = row(page, "pan").getByRole("button", { name: /Upload \/ Update/ });
  await pan.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Upload / Update KYC: PAN" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(pan).toBeFocused();
  expect(errors.errors).toEqual([]);
});

// ---- responsive ---------------------------------------------------------------------------------------------------------------------------
for (const width of VIEWPORTS) {
  test(`RESPONSIVE @${width}: the per-component KYC section (mixed states, complete, restricted) and its dialog have no horizontal page overflow and no console errors`, async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.setViewportSize({ width, height: width < 800 ? 900 : 800 });
    const measure = async (phase: string) => {
      const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
      expect(scrollWidth, `${phase} @${width}: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`).toBeLessThanOrEqual(innerWidth);
    };
    for (const key of ["Full", "PanMissing", "BankIncomplete", "Nothing"]) {
      await openDraft(page, S[key]!.agreementRef);
      await measure(`KYC ${key}`);
      if (width === 390 && key === "Nothing") await shotEl(kycSection(page), "37-kyc-390-all-missing");
    }
    const trigger = row(page, "pan").getByRole("button", { name: /Upload \/ Update/ });
    await openDraft(page, S.PanMissing!.agreementRef);
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await measure("KYC dialog");
    const box = await page.getByRole("dialog").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await signInAs(page, "manager");
    await openDraft(page, S.PanMissing!.agreementRef);
    await measure("KYC restricted (Manager)");
    expect(errors.errors).toEqual([]);
  });
}
