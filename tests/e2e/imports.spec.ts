import * as XLSX from "xlsx";
import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 12A: Import Center integration E2E - certifies the real, minimal
// UI wiring added to /imports?module=analytics (a real file upload ->
// dry-run -> execute round trip through the actual page), plus a route/
// auth skeleton check for who can reach it. This deliberately does NOT
// certify a final Analytics UI (none was built in this step) - see
// tests/e2e/authorization.spec.ts's own pre-existing "can reach Import
// Center (Analyst); cannot reach Import Center (Head, no role-rank
// fallback)" coverage for the broader per-role route-reachability proof,
// unchanged and unaffected by this step.
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

function uniqueContentWorkbook(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Post URL", "Comments", "Likes"],
    [`https://instagram.com/p/e2e-import-${Date.now()}`, "4", "9"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Posts");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test.describe("Import Center - Analytics real pipeline round trip", () => {
  test("Analyst: upload a real file, dry-run, then execute - a real batch is created", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/imports");
    await expect(page.locator("h1")).toHaveText("Import Center");

    const fileInput = page.locator("#import-file");
    await fileInput.setInputFiles({ name: "e2e-content-export.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: uniqueContentWorkbook() });

    await page.getByRole("button", { name: "Dry-run" }).click();
    await expect(page.getByText("Dry-run only - nothing was written.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/matched: 1|unmatched: 1/)).toBeVisible();

    await page.getByRole("button", { name: "Execute import" }).click();
    await expect(page.getByText(/Batch .* - (COMPLETED|COMPLETED_WITH_ERRORS)/)).toBeVisible({ timeout: 10_000 });
  });

  test("Viewer cannot see the Import Center nav link and is redirected away from the route", async ({ page }) => {
    await signInAs(page, "viewer");
    await expect(page.getByRole("link", { name: "Import Center" })).not.toBeVisible();
    await page.goto("/imports");
    // src/proxy.ts's own Feature Access gate redirects a denied feature
    // to /access-denied?feature=imports - the authoritative service-layer
    // proof of denial is analytics.emulator.test.ts's own authorization
    // coverage; this confirms the route-level skeleton actually enforces
    // it too, never dead-ending into a functional import form.
    await expect(page).toHaveURL(/\/access-denied\?feature=imports/);
  });
});
