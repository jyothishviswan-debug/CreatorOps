import { expect as baseExpect, type Locator, type Page } from "@playwright/test";

import { makeContractPdf, waitForHydration, type ContractVariant } from "./finance-agreements-fixtures";

// Shared browser helpers for the Step 14B.1 onboarding / KYC / document specs (kept out of finance-agreements-fixtures.ts, which is
// Admin-SDK only). Dev-mode route compilation makes the first call of an API route slow: allow more than the 5 s default for a UI outcome.
export const expect = baseExpect.configure({ timeout: 20_000 });

export const SHOTS = "/private/tmp/claude-501/-Users-jyothishviswan-Documents-GitHub-CreatorOps/f6532d82-64bb-46ec-b66b-e42c0c3b6670/scratchpad/shots14b1";

export async function shot(page: Page, name: string, options: { fullPage?: boolean } = {}) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: options.fullPage ?? true });
}

// A screenshot of ONE element (scrolled into view first), so a long page does not become an unreadable strip.
export async function shotEl(locator: Locator, name: string) {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: `${SHOTS}/${name}.png` });
}

export const radio = (page: Page, name: string | RegExp) => page.getByRole("radio", { name });

// Opens the new-Agreement form and waits until React owns the radios.
export async function openNewAgreement(page: Page, query = "") {
  await page.goto(`/finance/agreements/new${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "New Agreement" })).toBeVisible();
  await waitForHydration(page, '[role="radio"]');
}

export type WizardKind = "INSTAGRAM_PARTNER" | "YOUTUBE_PARTNER" | "IG_YT_PARTNER" | "VENDOR";
const CARD: Record<WizardKind, RegExp> = { INSTAGRAM_PARTNER: /^Instagram Partner/, YOUTUBE_PARTNER: /^YouTube Partner/, IG_YT_PARTNER: /^Instagram \+ YouTube Partner/, VENDOR: /^Vendor/ };

// `Agreement for` card -> `Create new Partner|Vendor from Agreement`: the wizard opens.
export async function openWizard(page: Page, kind: WizardKind) {
  await openNewAgreement(page);
  await radio(page, CARD[kind]).click();
  await radio(page, kind === "VENDOR" ? "Create new Vendor from Agreement" : "Create new Partner from Agreement").click();
  await expect(page.getByTestId("section-onboarding-upload")).toBeVisible();
}

export function pdfFile(variant: ContractVariant, fileName = "signed-agreement.pdf") {
  return { name: fileName, mimeType: "application/pdf", buffer: makeContractPdf(variant) };
}

// Upload + `Extract from Agreement` (the EPHEMERAL preview): waits for the extracted result.
export async function extractInWizard(page: Page, file: ReturnType<typeof pdfFile>) {
  await page.getByTestId("onboarding-file").setInputFiles(file);
  await expect(page.getByTestId("onboarding-selected-file")).toContainText(file.name);
  await page.getByTestId("onboarding-extract").click();
  await expect(page.getByTestId("onboarding-preview-result")).toBeVisible();
}

export const field = (page: Page, label: string | RegExp) => page.getByLabel(label, { exact: typeof label === "string" });

// `Check for existing ...`: waits for the duplicate-check result region.
export async function checkDuplicates(page: Page, noun: "Partner" | "Vendor") {
  await page.getByTestId("onboarding-check-duplicates").click();
  await expect(page.getByTestId("onboarding-duplicates-result")).toBeVisible();
  void noun;
}
