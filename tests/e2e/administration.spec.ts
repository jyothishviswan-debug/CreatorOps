import { test, expect, type Page } from "@playwright/test";

// This whole file runs against the `chromium` project's shared admin
// storageState (see playwright.config.ts) - every test here is already
// signed in as admin@creatorops.com (Super Admin), the only role with
// Administration's GLOBAL scope grant. Non-authorized-role denial is
// covered separately in authorization.spec.ts, which needs a fresh
// unauthenticated context per identity.

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@creatorops.com`;
}

async function provisionUser(page: Page, overrides: { displayName?: string; role?: string } = {}) {
  const email = uniqueEmail("e2e-user");
  const response = await page.request.post("/api/administration/users", {
    data: {
      email,
      password: "a-strong-e2e-password",
      displayName: overrides.displayName ?? "E2E Test User",
      role: overrides.role ?? "viewer",
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { userRef: string; email: string; displayName: string; role: string; version: number };
  return body;
}

test("Super Admin Administration Overview shows real, non-fake KPIs and panels", async ({ page }) => {
  await page.goto("/administration");
  await expect(page.locator("h1")).toHaveText("Administration");
  await expect(page.getByText("Live emulator data", { exact: true })).toBeVisible();

  await expect(page.getByText("Total users")).toBeVisible();
  await expect(page.getByText("Active Super Admins")).toBeVisible();
  await expect(page.getByText("Users by Role")).toBeVisible();
  await expect(page.getByText("Recent Activity")).toBeVisible();
});

test("Users workspace paginates through a bounded cursor, never repeating a user across pages", async ({ page }) => {
  // Guarantee more than one page at the smallest available page size
  // regardless of how much prior test data already exists in this
  // emulator - provision enough fresh users up front.
  const created = await Promise.all(Array.from({ length: 4 }, () => provisionUser(page)));

  await page.goto("/administration/users");
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  const perPageSelect = page.getByLabel("Rows per page");
  await perPageSelect.selectOption("10");
  await expect(page.locator("table tbody tr").first()).toBeVisible();

  const firstPageEmails = await page.locator("table tbody tr .person small").allTextContents();
  expect(firstPageEmails.length).toBeGreaterThan(0);

  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();

  // Keep paging until the cursor is exhausted - other tests in this file
  // run in parallel and also provision users, so more than one extra
  // page may be needed regardless of how much data has already
  // accumulated in this emulator.
  for (let guard = 0; guard < 20 && (await loadMore.count()) > 0; guard += 1) {
    const [response] = await Promise.all([page.waitForResponse((res) => res.url().includes("/api/administration/users") && res.request().method() === "GET"), loadMore.click()]);
    expect(response.ok()).toBeTruthy();
  }

  const allEmails = await page.locator("table tbody tr .person small").allTextContents();
  expect(new Set(allEmails).size).toBe(allEmails.length);
  for (const user of created) {
    expect(allEmails).toContain(user.email);
  }
});

test("provisioning a new user reaches their detail page with no raw Firebase uid anywhere in the response", async ({ page }) => {
  const email = uniqueEmail("e2e-provision");

  await page.goto("/administration/users/new");
  await page.getByPlaceholder("Ananya Rao").fill("E2E Provisioned User");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("a-strong-e2e-password");
  await page.locator(".formsection select").selectOption("analyst");
  await page.getByRole("button", { name: "Provision user" }).click();

  await expect(page).toHaveURL(/\/administration\/users\/[^/]+$/);
  await expect(page.locator("h1")).toHaveText("E2E Provisioned User");
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Analyst", { exact: true }).first()).toBeVisible();

  const userRef = page.url().split("/").pop()!;
  expect(userRef).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const dtoResponse = await page.request.get(`/api/administration/users/${userRef}`);
  const dto = await dtoResponse.json();
  expect(Object.keys(dto).sort()).toEqual(["active", "displayName", "email", "role", "userRef", "version"]);
});

test("role update, active/inactive update, scope grant add/remove, and effective access review all reflect on the same detail page", async ({ page }) => {
  const user = await provisionUser(page, { displayName: "E2E Lifecycle User", role: "viewer" });

  await page.goto(`/administration/users/${user.userRef}`);
  await expect(page.locator("h1")).toHaveText("E2E Lifecycle User");

  // Role update.
  await page.getByLabel("Role").selectOption("analyst");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("No changes to save")).toBeVisible();
  await expect(page.locator(".detailcontext").getByText("Analyst")).toBeVisible();

  // Active/inactive update - deactivating triggers a confirm() dialog.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Admission status").selectOption("inactive");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".detailcontext").getByText("Inactive")).toBeVisible();

  // Reactivate for the rest of the flow.
  await page.getByLabel("Admission status").selectOption("active");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".detailcontext").getByText("Active")).toBeVisible();

  // Add a representative REGION scope grant. The remove button's
  // aria-label uniquely identifies the editable chip (the same text also
  // appears read-only inside the Effective Access panel below).
  await page.getByLabel("Grant type").selectOption("REGION");
  await page.getByLabel("Region").fill("Test-Region");
  await page.getByRole("button", { name: "+ Add scope grant" }).click();
  const removeGrantButton = page.getByLabel("Remove Region: Test-Region");
  await expect(removeGrantButton).toBeVisible();

  // Effective access review reflects the same grant, from the same
  // server-returned DTO - not a client re-derivation.
  const effectiveAccessPanel = page.locator(".panel", { has: page.getByText("Effective access") });
  await expect(effectiveAccessPanel.getByText("Region: Test-Region")).toBeVisible();

  // Remove the grant - consequential removal is confirmed.
  page.once("dialog", (dialog) => dialog.accept());
  await removeGrantButton.click();
  await expect(removeGrantButton).toHaveCount(0);
  await expect(effectiveAccessPanel.getByText("Region: Test-Region")).toHaveCount(0);
});

test("a stale save (edited elsewhere first) is rejected with a reload prompt, not silently overwritten", async ({ page }) => {
  const user = await provisionUser(page, { displayName: "E2E Stale User" });

  await page.goto(`/administration/users/${user.userRef}`);
  await expect(page.locator("h1")).toHaveText("E2E Stale User");

  // Simulate someone else changing this record between page load and save.
  const externalPatch = await page.request.patch(`/api/administration/users/${user.userRef}`, {
    data: { displayName: "Changed By Someone Else", expectedVersion: user.version },
  });
  expect(externalPatch.ok()).toBeTruthy();

  await page.getByLabel("Display name").fill("My Local Edit");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("This user was modified elsewhere.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("sensitive-access category add/remove on the Access page", async ({ page }) => {
  const category = `e2e_category_${Date.now()}`;

  await page.goto("/administration/access");
  // Exact match: the role-segment button's accessible name is exactly
  // "Viewer", but several user rows in the panel below also contain the
  // substring "Viewer" (e.g. "Viewer (Test)"), which a substring match
  // would ambiguously match too.
  await page.getByRole("button", { name: "Viewer", exact: true }).click();
  await expect(page.getByText(`No sensitive categories granted to Viewer.`)).toBeVisible();

  await page.getByLabel("New sensitive category").fill(category);
  await page.getByRole("button", { name: "+ Add" }).click();
  // The category is unique per test run, so a plain substring match is
  // unambiguous - the chip's own text node sits beside a "✕" remove
  // button inside the same element, so an exact whole-element match
  // wouldn't find it.
  await expect(page.getByText(category)).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel(`Remove ${category}`).click();
  await expect(page.getByText(category)).toHaveCount(0);
});

test("an access-changing mutation is visible as an audit event immediately after", async ({ page }) => {
  const user = await provisionUser(page, { displayName: "E2E Audit Visible User" });

  const patchResponse = await page.request.patch(`/api/administration/users/${user.userRef}`, {
    data: { displayName: "E2E Audit Visible User (renamed)", expectedVersion: user.version },
  });
  expect(patchResponse.ok()).toBeTruthy();

  await page.goto("/administration/audit");
  const auditRow = page.locator("table tbody tr", { hasText: "E2E Audit Visible User (renamed)" });
  await expect(auditRow).toBeVisible();
  await expect(auditRow).toContainText("admin@creatorops.com");
  await expect(auditRow).toContainText("Profile updated");
});

test("an opaque, tampered userRef on a direct route is rejected with a not-found response, not a crash", async ({ page }) => {
  const response = await page.goto("/administration/users/this-token-does-not-exist-12345");
  expect(response?.status()).toBe(404);
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Users workspace to detail flow works at mobile width", async ({ page }) => {
    // A newly-provisioned user may sort onto a later page than the
    // default-loaded first page (ordering is by email), so this exercises
    // the generic first-row-to-detail flow rather than depending on
    // search finding one specific record - the same pattern used by
    // detail-flow.spec.ts for other modules' workspaces.
    await provisionUser(page, { displayName: "E2E Mobile Flow User" });

    await page.goto("/administration/users");
    const firstRow = page.locator("button.rowlink.person").first();
    await expect(firstRow).toBeVisible();
    const recordName = await firstRow.locator("b").innerText();
    await firstRow.click();

    await expect(page.locator("h1")).toHaveText(recordName);
    await expect(page.getByText("Back to users")).toBeVisible();

    await page.getByText("Back to users").click();
    await expect(page).toHaveURL(/\/administration\/users$/);
  });
});
