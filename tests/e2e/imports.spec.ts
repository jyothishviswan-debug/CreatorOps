import * as XLSX from "xlsx";
import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Import Center Completion - the real governed flow's flagship E2E:
// Choose Data -> Upload -> File/Sheet Preview -> Mapping (conditional) ->
// Validation & Diff / Review -> Import -> Results -> History. Exercises
// the ACTUAL page (src/app/imports/page.tsx ->
// src/features/imports/ImportCenterTabs.tsx), never a mocked import
// service - every dry-run/execute call here hits the real Analytics
// pipeline (or, for the contract-bundle denial test, the real Finance
// Agreements onboarding gate) against the running emulator.
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

async function signInAs(page: Page, name: string) {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

function workbookBuffer(sheetName: string, rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function uniqueContentWorkbook(): Buffer {
  return workbookBuffer("Posts", [
    ["Post URL", "Comments", "Likes"],
    [`https://instagram.com/p/e2e-import-${Date.now()}`, "4", "9"],
  ]);
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function uploadFile(page: Page, buffer: Buffer, filename = "e2e-content-export.xlsx") {
  await page.locator("#import-file").setInputFiles({ name: filename, mimeType: XLSX_MIME, buffer });
}

test.describe("Import Center - the real governed flow", () => {
  test("Analyst: Choose Data -> Upload -> Preview -> Review -> Import -> Results -> History", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await expect(page.locator("h1")).toHaveText("Import Center");

    // Choose Data
    await expect(page.getByRole("tab", { name: "Choose data" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    // Upload
    await uploadFile(page, uniqueContentWorkbook());
    await expect(page.getByText(/e2e-content-export\.xlsx/)).toBeVisible();
    await page.getByRole("button", { name: "Continue to preview" }).click();

    // File/Sheet Preview - real parsed headers/sample rows, bounded
    await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Post URL")).toBeVisible();
    await page.getByRole("button", { name: "Continue to validation" }).click();

    // Mapping is skipped automatically (a recognized sheet) straight to Review
    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/row\(s\) parsed · nothing has been written yet/)).toBeVisible();
    await expect(page.getByText(/Matched: 1|Unmatched: 1|Warning: 1/)).toBeVisible();

    // Review is mandatory - Import stays disabled until acknowledged
    const importButton = page.getByRole("button", { name: "Import" });
    await expect(importButton).toBeDisabled();
    await page.getByLabel("I have reviewed the counts and row outcomes above.").check();
    await expect(importButton).toBeEnabled();
    await importButton.click();

    // Results
    await expect(page.getByRole("tab", { name: "Results" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Completed|Completed with issues/)).toBeVisible({ timeout: 10_000 });

    // History
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("e2e-content-export.xlsx").first()).toBeVisible({ timeout: 10_000 });
  });

  test("a malformed/unsupported file is rejected with a classified error, never a generic failure", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    // A wrong extension/MIME type is rejected outright at the file-safety
    // layer, before parsing is ever attempted - a deterministic FILE-level
    // rejection (a corrupt-but-.xlsx-named buffer risks XLSX's own lenient
    // CSV-sniffing fallback silently "succeeding" instead - see
    // xlsx-parser.test.ts's own comment on this exact caveat).
    await page.locator("#import-file").setInputFiles({ name: "not-a-spreadsheet.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 this is not a spreadsheet") });
    await page.getByRole("button", { name: "Continue to preview" }).click();

    await expect(page.getByText(/File problem/)).toBeVisible({ timeout: 10_000 });
  });

  test("an unrecognized sheet blocks at Mapping with an actionable message - never a silent partial import", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    await uploadFile(page, workbookBuffer("Mystery", [["Foo", "Bar"], ["x", "y"]]), "unrecognized-sheet.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();

    await expect(page.getByRole("tab", { name: "Mapping" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/not recognized/i)).toBeVisible();
    await expect(page.getByText(/does not support manual column remapping/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to review" })).toHaveCount(0);
  });

  test("a row missing every identifying column is classified invalid (ERROR), a real row-level outcome, not a silent skip", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    // A row with a Comments value but no Post ID / Post URL at all.
    await uploadFile(page, workbookBuffer("Posts", [["Post URL", "Comments"], [null, "5"]]), "invalid-row.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();

    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Invalid row: 1/)).toBeVisible();
  });

  test("a row whose identity already belongs to a committed batch is recognized as a duplicate, never silently re-created", async ({ page }) => {
    // Uses the seeded "sharedhandle" fixture (seed-analytics-data.ts) -
    // ALREADY committed as an ambiguous-match source record under its own
    // seed batch, so a fresh import of the exact same identity is
    // downgraded to "duplicate" by the pipeline's own duplicate-check
    // (see import-pipeline.ts) - real, reachable proof that re-importing
    // an already-resolved identity is recognized, not silently repeated.
    await signInAs(page, "analyst");
    await page.goto("/imports");
    // "What kind of data is this?" lives on the Choose Data step itself.
    await page.getByLabel("What kind of data is this?").selectOption("channel_account");
    await page.getByRole("button", { name: "Continue to upload" }).click();
    // Platform defaults to instagram, matching the seeded fixture's own platform.
    await uploadFile(page, workbookBuffer("Accounts", [["Username"], ["sharedhandle"]]), "duplicate-identity.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();

    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Duplicate of another batch: 1/)).toBeVisible();
  });

  test("correction flow: an unrecognized-sheet file can be replaced with a valid one and re-validated, without restarting the whole session", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    await uploadFile(page, workbookBuffer("Mystery", [["Foo"], ["x"]]), "bad.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();
    await expect(page.getByRole("tab", { name: "Mapping" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("button", { name: "Back to upload" }).click();
    await expect(page.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
    await uploadFile(page, uniqueContentWorkbook(), "corrected.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();

    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("partial success: a file with one good row and one invalid row completes with issues, and shows both outcomes", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    const buffer = workbookBuffer("Posts", [
      ["Post URL", "Comments"],
      [`https://instagram.com/p/e2e-partial-${Date.now()}`, "2"],
      [null, "9"],
    ]);
    await uploadFile(page, buffer, "partial.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();
    await page.getByLabel("I have reviewed the counts and row outcomes above.").check();
    await page.getByRole("button", { name: "Import" }).click();

    await expect(page.getByText("Completed with issues")).toBeVisible({ timeout: 10_000 });
  });

  // Finding #58 - every eligible pre-commit step (Upload, Preview, plus the
  // pre-existing Mapping/Review) gets an explicit "Back" button, not just
  // the clickable step tabs. The first step (Choose data) has no meaningless
  // Back, and the post-commit Results step never offers one either (only
  // "Start a new import", a full, explicit reset - never an unsafe rewind
  // into an editable pre-commit state).
  test("finding #58: every eligible pre-commit step shows an explicit Back button; Choose data and the post-commit Results step do not", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");

    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);

    await page.getByRole("button", { name: "Continue to upload" }).click();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

    await uploadFile(page, uniqueContentWorkbook(), "back-visibility.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

    await page.getByRole("button", { name: "Continue to validation" }).click();
    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

    await page.getByLabel("I have reviewed the counts and row outcomes above.").check();
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.getByText(/Completed|Completed with issues/)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
  });

  // Finding #58, explicitly regression-testing #54: Back/Forward navigation
  // must never drop or desync the selected target kind, file, or any other
  // interpretation option - the final Import must always reflect whatever
  // is CURRENTLY visible on screen, never a stale earlier selection.
  test("finding #58 (regression-tests #54): Back/Forward navigation preserves file and target-kind selection, and Import always reflects the currently-visible target", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");

    await page.getByLabel("What kind of data is this?").selectOption("channel_account");
    await page.getByRole("button", { name: "Continue to upload" }).click();
    await expect(page.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");

    // Back to Choose data with no file picked yet - the target-kind selection must survive.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("tab", { name: "Choose data" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("What kind of data is this?")).toHaveValue("channel_account");

    // Forward again, pick a file, then Back to Choose data and Forward again - the file selection
    // must survive too, and Back must never silently re-upload/reset it.
    await page.getByRole("button", { name: "Continue to upload" }).click();
    await uploadFile(page, workbookBuffer("Accounts", [["Username"], [`e2e-back-${Date.now()}`]]), "back-forward.xlsx");
    await expect(page.getByText(/back-forward\.xlsx/)).toBeVisible();
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("tab", { name: "Upload" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/back-forward\.xlsx/)).toBeVisible();

    // Forward through to Review - the final Import must use the CURRENTLY selected target
    // (channel_account), never a stale/dropped earlier interpretation. A channel/account snapshot row
    // has no Post URL/identity-post concept, so it would show as an Invalid row if the wrong
    // (campaign_content) target were ever submitted instead of the one actually shown on screen.
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();
    await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/Invalid row/)).toHaveCount(0);

    await page.getByLabel("I have reviewed the counts and row outcomes above.").check();
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.getByText(/Completed|Completed with issues/)).toBeVisible({ timeout: 10_000 });
  });

  test("Viewer cannot see the Import Center nav link and is redirected away from the route", async ({ page }) => {
    await signInAs(page, "viewer");
    await expect(page.getByRole("link", { name: "Import Center" })).not.toBeVisible();
    await page.goto("/imports");
    await expect(page).toHaveURL(/\/access-denied\?feature=imports/);
  });

  test("restricted contract-bundle denial: an Analyst holds Import Center access but not Finance Agreements, and sees a classified permission error, not a generic failure", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await page.getByLabel("Import target").selectOption("contract_bundle");
    await page.getByRole("button", { name: "Continue to upload" }).click();

    await uploadFile(page, workbookBuffer("Bundle", [["Type", "Display Name", "Region"], ["Partner", "E2E Denied Partner", "IN"]]), "bundle.xlsx");
    await page.getByRole("button", { name: "Continue to preview" }).click();
    await page.getByRole("button", { name: "Continue to validation" }).click();

    await expect(page.getByText(/Not permitted/)).toBeVisible({ timeout: 10_000 });
  });

  test("mobile workflow: the wizard is usable at a phone width, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await expect(page.locator("h1")).toHaveText("Import Center");

    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(hasOverflow).toBe(false);

    await page.getByRole("button", { name: "Continue to upload" }).click();
    await uploadFile(page, uniqueContentWorkbook(), "mobile.xlsx");
    await expect(page.getByText(/mobile\.xlsx/)).toBeVisible();
  });

  // Spec section 16 - the six certified widths. No horizontal overflow at
  // any of them, and the Review step (checkbox + Import button + counts +
  // row table) stays reachable and operable throughout - not just the
  // Choose Data landing state.
  for (const width of [1440, 1200, 1050, 760, 390, 375]) {
    test(`responsive: no horizontal overflow at ${width}px, through Upload -> Preview -> Review`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "analyst");
      await page.goto("/imports");

      const overflowAt = async () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(await overflowAt()).toBe(false);

      await page.getByRole("button", { name: "Continue to upload" }).click();
      expect(await overflowAt()).toBe(false);

      await uploadFile(page, uniqueContentWorkbook(), `responsive-${width}.xlsx`);
      await page.getByRole("button", { name: "Continue to preview" }).click();
      expect(await overflowAt()).toBe(false);

      await page.getByRole("button", { name: "Continue to validation" }).click();
      await expect(page.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(await overflowAt()).toBe(false);

      const checkbox = page.getByLabel("I have reviewed the counts and row outcomes above.");
      await expect(checkbox).toBeVisible();
      await checkbox.check();
      await expect(page.getByRole("button", { name: "Import" })).toBeEnabled();
    });
  }
});
