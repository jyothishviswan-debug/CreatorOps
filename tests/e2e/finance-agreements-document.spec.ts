import { test, type Page } from "@playwright/test";

import {
  collectBrowserErrors,
  collectResponseBodies,
  createFinanceFixtures,
  makeContractPdf,
  noDocumentOverflow,
  renderedDom,
  signInAs,
  SUPPORTED_READY_DECISIONS,
  uniqueIdentity,
  VIEWPORTS,
  type FinanceFixtures,
} from "./helpers/finance-agreements-fixtures";
import { expect, shotEl } from "./helpers/finance-onboarding-helpers";
import { waitForHydration } from "./helpers/finance-agreements-fixtures";
import { financeAgreementsCollection, financeContractArtifactsCollection } from "@/server/finance-agreements/firestore";

// Step 14B.1 e2e: the ORIGINAL signed Agreement document (Drive) through the real UI, with the FAKE adapter (FINANCE_AGREEMENT_DRIVE_MODE=fake -> links
// look like https://drive.invalid/fake/<id>; a real Drive is never reached). Confirm -> automatic store; Head sees the link, a Manager sees the status
// but no link; Partner detail / Vendor detail show the SAME file; Activate waits for the store; v1 keeps its own file; a revision without a new signed
// file says so.

test.describe.configure({ mode: "serial" });

const TAG = `FDO${Date.now().toString(36)}`;
const fx: FinanceFixtures = createFinanceFixtures(TAG);
const FAKE_LINK = /^https:\/\/drive\.invalid\/fake\/fake_[0-9a-f]{24}$/;

type Ref = { agreementRef: string; partnerRef?: string; vendorRef?: string; fileName: string };
const A: Record<string, Ref> = {};

// The ready decisions, as CORRECTED wherever they carry a value: with an attached extraction the same fields already hold a (different) proposed value, and only a
// CORRECTED decision may replace it.
const READY_OVER_EXTRACTION = SUPPORTED_READY_DECISIONS.map((seed) => (seed.value !== undefined && seed.decision === "ACCEPTED" ? { ...seed, decision: "CORRECTED" as const } : seed));

// A confirmable draft backed by an uploaded, extracted and attached signed Agreement (every field decided; NOT confirmed).
async function readyBackedPartnerDraft(key: string, fileName: string, pdfName: string) {
  const id = uniqueIdentity(key);
  const partner = await fx.seedPartner({ displayName: `${TAG} ${key}`, email: id.email, phone: id.phoneNormalized });
  const account = await fx.seedAccount(partner, "instagram", { handle: `${key.toLowerCase()}_ig`, primary: true });
  await fx.fullKyc(fx.partnerSubject(partner));
  const draft = await fx.newDraft(fx.partnerCp(partner, [account.partnerAccountRef]), "admin");
  const attached = await fx.attachContract(draft, makeContractPdf({ name: pdfName, email: id.email, phone: id.phone }), "admin", fileName);
  const decided = await fx.acceptPending(await fx.decideAll(attached, READY_OVER_EXTRACTION, "admin"), "admin");
  return { partner, detail: decided };
}

test.beforeAll(async () => {
  await fx.grantFixtureRegion();

  // Browser-confirmed: a ready, artifact-backed draft (the spec presses Confirm and watches the automatic store).
  const browser = await readyBackedPartnerDraft("Browser", "browser-signed.pdf", `${TAG} Browser Signer`);
  A.Browser = { agreementRef: browser.detail.head.agreementRef, partnerRef: browser.partner.partnerRef, fileName: "browser-signed.pdf" };

  // Confirmed + STORED (through the service): what Head / Manager / Partner detail read.
  const stored = await readyBackedPartnerDraft("Stored", "stored-signed.pdf", `${TAG} Stored Signer`);
  const storedDetail = await fx.storeDocument(await fx.confirm(stored.detail, "admin"), "admin");
  A.Stored = { agreementRef: storedDetail.head.agreementRef, partnerRef: stored.partner.partnerRef, fileName: "stored-signed.pdf" };

  // Confirmed, NOT stored: Activate must wait.
  const pending = await readyBackedPartnerDraft("Pending", "pending-signed.pdf", `${TAG} Pending Signer`);
  const pendingDetail = await fx.confirm(pending.detail, "admin");
  A.Pending = { agreementRef: pendingDetail.head.agreementRef, partnerRef: pending.partner.partnerRef, fileName: "pending-signed.pdf" };

  // Manual-only: no signed file at all - activation is never blocked, and the panel says so honestly.
  const manualPartner = await fx.seedPartner({ displayName: `${TAG} Manual` });
  const manual = await fx.seedConfirmed(fx.partnerCp(manualPartner));
  A.Manual = { agreementRef: manual.head.agreementRef, partnerRef: manualPartner.partnerRef, fileName: "" };

  // v1 ACTIVE with its own stored file + an OPEN v2 revision that gets ITS OWN new signed file, confirmed and stored.
  const twoFiles = await readyBackedPartnerDraft("TwoFiles", "v1-signed.pdf", `${TAG} Two Files V1`);
  const v1Active = await fx.activate(await fx.storeDocument(await fx.confirm(twoFiles.detail, "admin"), "admin"), "head");
  const rev = await import("@/server/finance-agreements").then(async (mod) => {
    const outcome = await mod.createAgreementRevision(await fx.actorOf("head"), { agreementRef: v1Active.head.agreementRef, expectedDocVersion: v1Active.head.docVersion }, `e2e-rev-${TAG}`);
    if (!outcome.ok) throw new Error(`revise: ${outcome.code}`);
    return outcome.data;
  });
  const idTwo = uniqueIdentity("twofiles2");
  const v2Attached = await fx.attachContract(rev, makeContractPdf({ name: `${TAG} Two Files V2`, email: idTwo.email, phone: idTwo.phone }), "admin", "v2-signed.pdf");
  const v2 = await fx.storeDocument(await fx.confirm(await fx.acceptPending(v2Attached, "admin"), "admin"), "admin", 2);
  A.TwoFiles = { agreementRef: v2.head.agreementRef, partnerRef: twoFiles.partner.partnerRef, fileName: "v1-signed.pdf" };

  // v1 ACTIVE with a stored file + a v2 revision confirmed WITHOUT a new signed file.
  const noNew = await readyBackedPartnerDraft("NoNewFile", "only-v1-signed.pdf", `${TAG} No New File`);
  const noNewActive = await fx.activate(await fx.storeDocument(await fx.confirm(noNew.detail, "admin"), "admin"), "head");
  const mod = await import("@/server/finance-agreements");
  const revision = await mod.createAgreementRevision(await fx.actorOf("head"), { agreementRef: noNewActive.head.agreementRef, expectedDocVersion: noNewActive.head.docVersion }, `e2e-rev2-${TAG}`);
  if (!revision.ok) throw new Error(`revise: ${revision.code}`);
  const v2NoFile = await fx.confirm(await fx.acceptPending(await fx.decideAll(revision.data, [{ fieldKey: "terminationDate", decision: "CORRECTED", value: "2025-09-30" }], "admin"), "admin"), "admin");
  A.NoNewFile = { agreementRef: v2NoFile.head.agreementRef, partnerRef: noNew.partner.partnerRef, fileName: "only-v1-signed.pdf" };

  // A Vendor Agreement with a stored file (Vendor Agreements panel).
  const vendor = await fx.seedVendor({ displayName: `${TAG} Vendor Doc` });
  await fx.fullKyc(fx.vendorSubject(vendor));
  const idV = uniqueIdentity("vdoc");
  const vDraft = await fx.newDraft(fx.vendorCp(vendor), "admin");
  const vAttached = await fx.attachContract(vDraft, makeContractPdf({ name: `${TAG} Vendor Signer`, email: idV.email, phone: idV.phone }), "admin", "vendor-signed.pdf");
  const vStored = await fx.storeDocument(await fx.confirm(await fx.acceptPending(await fx.decideAll(vAttached, READY_OVER_EXTRACTION, "admin"), "admin"), "admin"), "admin");
  A.Vendor = { agreementRef: vStored.head.agreementRef, vendorRef: vendor.vendorRef, fileName: "vendor-signed.pdf" };
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

const open = async (page: Page, key: string, query = "") => {
  await page.goto(`/finance/agreements/${A[key]!.agreementRef}${query}`);
  await expect(page.getByRole("tablist", { name: "Agreement sections" })).toBeVisible();
};
const panel = (page: Page) => page.locator(".panel", { has: page.getByRole("heading", { name: "Agreement document" }) });
const docRow = (page: Page, version: number) => page.getByTestId(`document-row-${version}`);
const openLink = (scope: ReturnType<Page["locator"]>) => scope.getByRole("link", { name: /Open Agreement document/ });

async function openPartnerContext(page: Page, partnerRef: string) {
  await page.goto(`/partners/${partnerRef}`);
  await waitForHydration(page, '[role="tab"]');
  await page.getByRole("tab", { name: "Context" }).click();
}
async function openVendorPayee(page: Page, vendorRef: string) {
  await page.goto(`/vendors/${vendorRef}`);
  await waitForHydration(page, '[role="tab"]');
  await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
}

async function versionDoc(agreementRef: string, version: number) {
  return (await financeAgreementsCollection().doc(agreementRef).collection("versions").doc(String(version)).get()).data()!.document as { status: string; driveFileId: string; driveLink: string; fileName: string } | null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
test("FAKE MODE is verified before anything is confirmed: the stored reference is a drive.invalid link, never a real Drive URL", async () => {
  const document = await versionDoc(A.Stored!.agreementRef, 1);
  expect(document?.status).toBe("STORED");
  expect(document?.driveLink).toMatch(FAKE_LINK);
  expect(document?.driveLink).not.toContain("drive.google.com");
  expect(document?.fileName).toBe("stored-signed.pdf");
});

test("CONFIRM -> automatic store: right after Confirm the original signed Agreement is stored (status + file name), with a visible status; Activate then works", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await page.goto(`/finance/agreements/new?agreementRef=${A.Browser!.agreementRef}&version=1`);
  await expect(page.getByRole("heading", { level: 1, name: "Agreement draft" })).toBeVisible();
  const review = page.getByTestId("intake-review");
  await expect(review.getByTestId("confirm-agreement")).toBeEnabled({ timeout: 30_000 });
  await review.getByTestId("confirm-agreement").click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm Agreement" }).click();
  await expect(page.getByTestId("intake-status")).toContainText("Agreement confirmed. Its terms are now frozen.");
  // stored automatically (no second click)
  await expect(review).toContainText("Stored. The original signed Agreement is in Drive.", { timeout: 30_000 });
  await shotEl(review, "25-review-confirm-document-stored");
  const document = await versionDoc(A.Browser!.agreementRef, 1);
  expect(document?.status).toBe("STORED");
  expect(document?.fileName).toBe("browser-signed.pdf");
  expect(document?.driveLink).toMatch(FAKE_LINK);
  // the admin holds the contract-detail category: the link is here, and is the same one stored on the version
  await expect(openLink(review)).toHaveAttribute("href", document!.driveLink);
  await open(page, "Browser");
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "STORED");
  await expect(docRow(page, 1)).toContainText("browser-signed.pdf");
  await expect(openLink(docRow(page, 1))).toHaveAttribute("href", document!.driveLink);
  expect(errors.errors).toEqual([]);
});

test("HEAD sees status, file name, stored time and `Open Agreement document` with the drive.invalid link; the panel holds no store button once stored", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "head");
  await open(page, "Stored");
  const heading = page.getByRole("heading", { name: "Agreement document" });
  await expect(heading).toBeVisible();
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "STORED");
  await expect(docRow(page, 1)).toContainText("Original file name");
  await expect(docRow(page, 1)).toContainText("stored-signed.pdf");
  await expect(docRow(page, 1)).toContainText("Stored");
  const link = openLink(docRow(page, 1));
  await expect(link).toHaveAttribute("href", FAKE_LINK);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(page.getByTestId("document-store-1")).toHaveCount(0);
  await shotEl(panel(page), "26-detail-document-stored-head");
  expect(errors.errors).toEqual([]);
});

test("MANAGER (no finance_contracts): sees the document STATUS and file name but NO link - not in the page, the DOM or any response", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const bodies = collectResponseBodies(page);
  await signInAs(page, "manager");
  await open(page, "Stored");
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "STORED");
  await expect(docRow(page, 1)).toContainText("stored-signed.pdf");
  await expect(docRow(page, 1)).toContainText("Agreement document on file");
  await expect(openLink(page.locator("main"))).toHaveCount(0);
  await open(page, "Stored", "?tab=versions");
  await expect(page.getByTestId("version-document-1")).toContainText("stored-signed.pdf");
  await expect(openLink(page.locator("main"))).toHaveCount(0);
  await shotEl(page.getByTestId("version-document-1"), "27-versions-document-manager-no-link");
  const dom = await renderedDom(page);
  expect(dom).not.toContain("drive.invalid");
  for (const body of bodies.bodies) expect(body.text, body.url).not.toContain("drive.invalid");
  // the API itself: the DTO carries no link for this actor
  const response = await page.request.get(`/api/finance/agreements/${A.Stored!.agreementRef}/document?version=1`);
  expect(response.status()).toBe(200);
  expect(await response.text()).not.toContain("drive.invalid");
  expect(errors.errors).toEqual([]);
});

test("ACTIVATE waits for the store: disabled with the plain reason while the signed file is not stored; `Store Agreement document` stores it (one file); then Activate works", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "head");
  await open(page, "Pending");
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "PENDING");
  await expect(docRow(page, 1)).toContainText("The original signed Agreement is not stored yet.");
  const activate = page.getByRole("button", { name: "Activate Agreement", exact: true });
  await expect(activate).toBeDisabled();
  await expect(page.locator("main")).toContainText("Store the signed Agreement document before activating this version.");
  await shotEl(panel(page), "28-detail-document-not-stored");
  await expect(openLink(docRow(page, 1))).toHaveCount(0);

  // a double click on Store makes ONE file
  const store = page.getByTestId("document-store-1");
  await expect(store).toHaveText("Store Agreement document");
  await store.dblclick();
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "STORED", { timeout: 30_000 });
  await expect(docRow(page, 1)).toContainText("pending-signed.pdf");
  const document = await versionDoc(A.Pending!.agreementRef, 1);
  expect(document?.driveLink).toMatch(FAKE_LINK);
  await expect(openLink(docRow(page, 1))).toHaveAttribute("href", document!.driveLink);
  await expect(activate).toBeEnabled();
  await activate.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Activate Agreement", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await financeAgreementsCollection().doc(A.Pending!.agreementRef).get()).data()?.status, { timeout: 20_000 }).toBe("ACTIVE");
  expect(errors.errors).toEqual([]);
});

test("RETRY: a failed store (the request fails before the server ran) can be retried and stores exactly ONE file; a lost RESPONSE after a successful store returns the same file on retry", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  // a second confirmed, unstored Agreement for this test
  const retry = await readyBackedPartnerDraft("RetryStore", "retry-signed.pdf", `${TAG} Retry Signer`);
  const confirmed = await fx.confirm(retry.detail, "admin");
  A.RetryStore = { agreementRef: confirmed.head.agreementRef, partnerRef: retry.partner.partnerRef, fileName: "retry-signed.pdf" };
  let posts = 0;
  await page.route(/\/api\/finance\/agreements\/[^/]+\/document$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    if (posts === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Storage is temporarily unavailable." }) });
    if (posts === 2) {
      await route.fetch(); // stored on the server ...
      await route.abort("connectionreset"); // ... but the browser never hears
      return;
    }
    return route.continue();
  });
  await open(page, "RetryStore");
  const store = page.getByTestId("document-store-1");
  await store.click();
  await expect(docRow(page, 1)).toContainText("was not stored", { timeout: 20_000 });
  expect((await versionDoc(A.RetryStore!.agreementRef, 1))?.status ?? "PENDING").not.toBe("STORED");
  await shotEl(panel(page), "29-detail-document-store-failed");
  await store.click(); // 2nd attempt: the server stores, the response is lost
  await expect(docRow(page, 1)).toContainText("was not stored", { timeout: 20_000 });
  expect((await versionDoc(A.RetryStore!.agreementRef, 1))?.status).toBe("STORED");
  const firstLink = (await versionDoc(A.RetryStore!.agreementRef, 1))!.driveLink;
  await page.reload();
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "STORED");
  await expect(openLink(docRow(page, 1))).toHaveAttribute("href", firstLink);
  // the artifact is intact and only ONE file / one reference exists for this version
  const artifacts = await financeContractArtifactsCollection().where("counterparty.ref", "==", A.RetryStore!.partnerRef).get();
  expect(artifacts.size).toBe(1);
  expect((await versionDoc(A.RetryStore!.agreementRef, 1))!.driveLink).toBe(firstLink);
  expect(errors.errors).toEqual([]);
});

test("MANUAL-ONLY Agreement (no signed file): the panel says `No new signed document for this version`, there is nothing to store, and Activate is NOT blocked", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "head");
  await open(page, "Manual");
  await expect(docRow(page, 1)).toHaveAttribute("data-document-status", "NOT_APPLICABLE");
  await expect(docRow(page, 1)).toContainText("No new signed document for this version");
  await expect(page.getByTestId("document-store-1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activate Agreement", exact: true })).toBeEnabled();
  await shotEl(panel(page), "30-detail-document-manual-only");
  await open(page, "Manual", "?tab=versions");
  await expect(page.getByTestId("version-document-1")).toContainText("No new signed document for this version");
  expect(errors.errors).toEqual([]);
});

test("v1 KEEPS ITS OWN DOCUMENT when v2 stores a NEW signed file: distinct files and links, v1's link is never overwritten", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "head");
  const v1 = await versionDoc(A.TwoFiles!.agreementRef, 1);
  const v2 = await versionDoc(A.TwoFiles!.agreementRef, 2);
  expect(v1?.status).toBe("STORED");
  expect(v2?.status).toBe("STORED");
  expect(v1!.driveLink).not.toBe(v2!.driveLink);
  expect(v1!.driveFileId).not.toBe(v2!.driveFileId);
  expect(v1!.fileName).toBe("v1-signed.pdf");
  expect(v2!.fileName).toBe("v2-signed.pdf");
  await open(page, "TwoFiles", "?tab=versions");
  await expect(page.getByTestId("version-document-1")).toContainText("v1-signed.pdf");
  await expect(page.getByTestId("version-document-2")).toContainText("v2-signed.pdf");
  await expect(openLink(page.getByTestId("version-document-1"))).toHaveAttribute("href", v1!.driveLink);
  await expect(openLink(page.getByTestId("version-document-2"))).toHaveAttribute("href", v2!.driveLink);
  await shotEl(page.locator(".tablewrap", { has: page.getByTestId("version-row-1") }), "31-versions-document-column");
  // the Overview shows the version being viewed (v1 = current) and the waiting v2, each with its OWN link
  await open(page, "TwoFiles");
  await expect(openLink(docRow(page, 1))).toHaveAttribute("href", v1!.driveLink);
  await expect(openLink(docRow(page, 2))).toHaveAttribute("href", v2!.driveLink);
  expect(errors.errors).toEqual([]);
});

test("a revision WITHOUT a new signed file reads `No new signed document for this version` - the prior file is never presented as v2's; v1 keeps its link", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "head");
  const v1 = await versionDoc(A.NoNewFile!.agreementRef, 1);
  expect(v1?.status).toBe("STORED");
  expect(await versionDoc(A.NoNewFile!.agreementRef, 2)).toBeNull(); // v2 has no document of its own
  await open(page, "NoNewFile", "?tab=versions");
  await expect(page.getByTestId("version-document-1")).toContainText("only-v1-signed.pdf");
  await expect(openLink(page.getByTestId("version-document-1"))).toHaveAttribute("href", v1!.driveLink);
  await expect(page.getByTestId("version-document-2")).toContainText("No new signed document for this version");
  await expect(openLink(page.getByTestId("version-document-2"))).toHaveCount(0);
  await expect(page.getByTestId("version-document-2")).not.toContainText("only-v1-signed.pdf");
  // and v2 (confirmed, no signed file) can be activated
  await open(page, "NoNewFile");
  await expect(page.getByRole("button", { name: "Activate Agreement", exact: true })).toBeEnabled();
  expect(errors.errors).toEqual([]);
});

test("PARTNER detail Finance tile lists the SAME stored file and link for a Head; a Manager sees the file but NO link; a person without the Finance feature sees no Agreement text", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const stored = await versionDoc(A.Stored!.agreementRef, 1);
  await signInAs(page, "head");
  await openPartnerContext(page, A.Stored!.partnerRef!);
  const list = page.getByTestId("agreement-documents");
  await expect(list).toBeVisible();
  await expect(list).toContainText("stored-signed.pdf");
  await expect(openLink(list)).toHaveAttribute("href", stored!.driveLink);
  await shotEl(list.locator("xpath=ancestor::*[contains(@class,'panel')][1]"), "32-partner-detail-finance-tile-document");

  await signInAs(page, "manager");
  await openPartnerContext(page, A.Stored!.partnerRef!);
  await expect(page.getByTestId("agreement-documents")).toContainText("stored-signed.pdf");
  await expect(openLink(page.getByTestId("agreement-documents"))).toHaveCount(0);
  await expect(page.getByTestId("agreement-documents")).toContainText("Agreement document on file");
  expect(await renderedDom(page)).not.toContain("drive.invalid");
  expect(errors.errors).toEqual([]);
});

test("VENDOR detail Agreements panel lists the SAME stored file and link for a Head; a Manager sees no link", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const stored = await versionDoc(A.Vendor!.agreementRef, 1);
  await signInAs(page, "head");
  await openVendorPayee(page, A.Vendor!.vendorRef!);
  await expect(page.getByRole("heading", { name: "Agreements" })).toBeVisible();
  const list = page.getByTestId("agreement-documents");
  await expect(list).toContainText("vendor-signed.pdf");
  await expect(openLink(list)).toHaveAttribute("href", stored!.driveLink);
  await shotEl(list.locator("xpath=ancestor::*[contains(@class,'panel')][1]"), "33-vendor-agreements-panel-document");
  await signInAs(page, "manager");
  await openVendorPayee(page, A.Vendor!.vendorRef!);
  await expect(page.getByTestId("agreement-documents")).toContainText("vendor-signed.pdf");
  await expect(openLink(page.getByTestId("agreement-documents"))).toHaveCount(0);
  expect(await renderedDom(page)).not.toContain("drive.invalid");
  expect(errors.errors).toEqual([]);
});

// ---- keyboard / five-role / responsive -------------------------------------------------------------------------------------------------------
test("KEYBOARD: a lifecycle dialog opened from its button closes on Escape, leaves the Agreement unchanged and returns focus to the exact button", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "head");
  await open(page, "Manual");
  const activate = page.getByRole("button", { name: "Activate Agreement", exact: true });
  await activate.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Activate this version?");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(activate).toBeFocused();
  expect((await financeAgreementsCollection().doc(A.Manual!.agreementRef).get()).data()?.status).toBe("DRAFT");
  expect(errors.errors).toEqual([]);
});

test("FIVE-ROLE MATRIX (document): admin and head see the link; manager sees the status only; viewer and analyst get the neutral denial in the UI and the API, and see no Agreement text on the Partner / Vendor pages", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const stored = await versionDoc(A.Stored!.agreementRef, 1);
  for (const role of ["admin", "head"] as const) {
    await signInAs(page, role);
    await open(page, "Stored");
    await expect(openLink(docRow(page, 1))).toHaveAttribute("href", stored!.driveLink);
    const api = await page.request.get(`/api/finance/agreements/${A.Stored!.agreementRef}/document?version=1`);
    expect(await api.text()).toContain(stored!.driveLink);
  }
  await signInAs(page, "manager");
  await open(page, "Stored");
  await expect(docRow(page, 1)).toContainText("stored-signed.pdf");
  await expect(openLink(page.locator("main"))).toHaveCount(0);
  for (const role of ["viewer", "analyst"] as const) {
    await signInAs(page, role);
    await page.goto(`/finance/agreements/${A.Stored!.agreementRef}`);
    await expect(page).toHaveURL(/\/access-denied\?feature=finance/);
    const api = await page.request.get(`/api/finance/agreements/${A.Stored!.agreementRef}/document?version=1`);
    expect(api.status()).toBe(403);
    expect(await api.json()).toEqual({ error: "Forbidden." });
    const documents = await page.request.get(`/api/finance/counterparties/documents?counterpartyType=PARTNER&ref=${A.Stored!.partnerRef}`);
    expect(documents.status()).toBe(403);
    expect(await page.request.post(`/api/finance/agreements/${A.Pending!.agreementRef}/document`, { data: { version: 1, expectedDocVersion: 1 } }).then((response) => response.status())).toBe(403);
    // Partner / Vendor pages: the profile is visible (Partners / Vendors access), the Agreement document is not
    await page.goto(`/partners/${A.Stored!.partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Context" }).click();
    await expect(page.getByTestId("agreement-documents")).toHaveCount(0);
    expect(await renderedDom(page)).not.toContain("stored-signed.pdf");
    expect(await renderedDom(page)).not.toContain("drive.invalid");
  }
  expect(errors.errors).toEqual([]);
});

for (const width of VIEWPORTS) {
  test(`RESPONSIVE @${width}: the Agreement document panel, the Versions Document column and the Partner / Vendor document lists have no horizontal page overflow and no console errors`, async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await page.setViewportSize({ width, height: width < 800 ? 900 : 800 });
    await signInAs(page, "head");
    const measure = async (phase: string) => {
      const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
      expect(scrollWidth, `${phase} @${width}: scrollWidth ${scrollWidth} > innerWidth ${innerWidth}`).toBeLessThanOrEqual(innerWidth);
    };
    for (const key of ["Stored", "TwoFiles", "NoNewFile", "Manual", "RetryStore"]) {
      if (!A[key]) continue;
      await open(page, key);
      await measure(`Overview ${key}`);
      await open(page, key, "?tab=versions");
      await measure(`Versions ${key}`);
    }
    await open(page, "TwoFiles");
    if (width === 390) await shotEl(panel(page), "38-detail-document-390-two-versions");
    await openPartnerContext(page, A.Stored!.partnerRef!);
    await measure("Partner Finance tile");
    await openVendorPayee(page, A.Vendor!.vendorRef!);
    await measure("Vendor Agreements panel");
    expect(errors.errors).toEqual([]);
  });
}

