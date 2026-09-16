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

test("Users workspace paginates with numbered page controls (10 per page), never repeating a user across pages", async ({ page }) => {
  // Bounded and self-contained regardless of how much unrelated data has
  // accumulated in this emulator across repeated local test runs: all 12
  // provisioned users share a role no other test in this file uses, so
  // filtering by it gives a small, exactly-known dataset to paginate
  // through instead of searching for needles across the whole directory.
  const created = await Promise.all(Array.from({ length: 12 }, () => provisionUser(page, { role: "partnership_head" })));

  await page.goto("/administration/users");
  await page.getByLabel("Filter role").selectOption("Partnership Head");
  // A one-shot allTextContents() snapshot can race a still-settling
  // render (the initial SSR content briefly swapped for a client
  // re-render) - toPass() retries reading AND asserting together so the
  // value used afterward is the one that actually satisfied the check.
  let firstPageEmails: string[] = [];
  await expect(async () => {
    firstPageEmails = await page.locator("table tbody tr .person small").allTextContents();
    expect(firstPageEmails.length).toBe(10);
  }).toPass({ timeout: 10_000 });

  const pager = page.locator("nav[aria-label='Pagination']");
  const next = pager.getByRole("button", { name: "Next" });
  await expect(next).toBeEnabled();

  const allEmailSets: string[][] = [firstPageEmails];
  // Keep paging forward with the numbered Next control until exhausted -
  // other Partnership Head test identities/leftover data may add a page
  // or two beyond the 12 just created here.
  for (let guard = 0; guard < 10 && (await next.isEnabled()); guard += 1) {
    const [response] = await Promise.all([page.waitForResponse((res) => res.url().includes("/api/administration/users") && res.request().method() === "GET"), next.click()]);
    expect(response.ok()).toBeTruthy();
    allEmailSets.push(await page.locator("table tbody tr .person small").allTextContents());
    if (!(await next.isEnabled())) break;
  }

  // Page numbers 1..N are now all clickable and instantly cached - jump
  // back to page 1 without a network request and confirm it matches what
  // was first loaded (no re-fetch drift).
  await pager.getByRole("button", { name: "1", exact: true }).click();
  await expect(page.locator("table tbody tr .person small")).toHaveText(firstPageEmails);

  const allEmails = allEmailSets.flat();
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

  // Add a representative REGION scope grant.
  await page.getByLabel("Grant type").selectOption("REGION");
  await page.getByLabel("Region").fill("Test-Region");
  await page.getByRole("button", { name: "+ Add scope grant" }).click();
  const removeGrantButton = page.getByLabel("Remove Region: Test-Region");
  await expect(removeGrantButton).toBeVisible();

  // The Effective Access summary panel links through to the full
  // module/action matrix editor on the Access page for this exact user -
  // not a second, duplicated authorization interpretation on this page.
  const effectiveAccessPanel = page.locator(".panel", { has: page.getByText("Effective access") });
  await expect(effectiveAccessPanel.getByRole("link", { name: "Manage module & action access" })).toHaveAttribute("href", `/administration/access?user=${user.userRef}`);

  // Remove the grant - consequential removal is confirmed.
  page.once("dialog", (dialog) => dialog.accept());
  await removeGrantButton.click();
  await expect(removeGrantButton).toHaveCount(0);
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
  // The category picker is a fixed catalog dropdown, not free text (an
  // admin shouldn't have to know the raw category id) - Viewer starts
  // with no sensitive categories granted (seed-access-data.ts), so this
  // exercises the full add/remove cycle without colliding with any other
  // seeded identity's categories.
  const category = "partner_contact_info";
  const categoryLabel = "Partner contact info";

  await page.goto("/administration/access");
  // Exact match: the role-segment button's accessible name is exactly
  // "Viewer", but several user rows in the panel below also contain the
  // substring "Viewer" (e.g. "Viewer (Test)"), which a substring match
  // would ambiguously match too.
  await page.getByRole("button", { name: "Viewer", exact: true }).click();
  await expect(page.getByText(`No sensitive categories granted to Viewer.`)).toBeVisible();

  await page.getByLabel("New sensitive category").selectOption(category);
  await page.getByRole("button", { name: "+ Add" }).click();
  // Scoped to the granted-category pill, not a page-wide text match - once
  // removed, the category's label reappears as a plain <option> in the
  // picker (no longer excluded from the available list), which a
  // page-wide getByText would also match.
  const categoryPill = page.locator(".pill.purple", { hasText: categoryLabel });
  await expect(categoryPill).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel(`Remove ${category}`).click();
  await expect(categoryPill).toHaveCount(0);
});

test("an access-changing mutation is visible as an audit event immediately after", async ({ page }) => {
  const user = await provisionUser(page, { displayName: "E2E Audit Visible User" });

  const patchResponse = await page.request.patch(`/api/administration/users/${user.userRef}`, {
    data: { displayName: "E2E Audit Visible User (renamed)", expectedVersion: user.version },
  });
  expect(patchResponse.ok()).toBeTruthy();

  await page.goto("/administration/audit");
  // This user has two audit rows (the provisioning itself, then this
  // rename) sharing the same unique email, so scope by BOTH the email and
  // the renamed text to pinpoint the rename event specifically - a static
  // display-name string alone isn't unique across repeated emulator runs.
  // The trail is ordered newest-first and other tests write events in
  // parallel, so this specific row may have been pushed past page 1 by
  // the time this test looks - page forward (bounded) until it's found.
  const auditRow = page.locator("table tbody tr").filter({ hasText: user.email }).filter({ hasText: "renamed" });
  const next = page.locator("nav[aria-label='Pagination']").getByRole("button", { name: "Next" });
  for (let guard = 0; guard < 20 && (await auditRow.count()) === 0 && (await next.isEnabled().catch(() => false)); guard += 1) {
    await next.click();
  }
  await expect(auditRow).toBeVisible();
  await expect(auditRow).toContainText("admin@creatorops.com");
  await expect(auditRow).toContainText("Profile updated");
});

test("an opaque, tampered userRef on a direct route is rejected with a not-found response, not a crash", async ({ page }) => {
  const response = await page.goto("/administration/users/this-token-does-not-exist-12345");
  expect(response?.status()).toBe(404);
});

test("Audit page paginates with numbered page controls (10 per page)", async ({ page }) => {
  // Guarantee more than one audit page - each provision writes one event.
  await Promise.all(Array.from({ length: 12 }, () => provisionUser(page)));

  await page.goto("/administration/audit");
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  const firstPageRows = await page.locator("table tbody tr").count();
  expect(firstPageRows).toBe(10);

  const pager = page.locator("nav[aria-label='Pagination']");
  const next = pager.getByRole("button", { name: "Next" });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(pager.getByRole("button", { name: "2", exact: true })).toHaveAttribute("aria-current", "page");
});

test("Access page: search for a user, select them, and edit their module/action access via the matrix", async ({ page }) => {
  const user = await provisionUser(page, { displayName: "E2E Matrix User", role: "partnership_manager" });

  await page.goto("/administration/access");
  await expect(page.getByRole("heading", { name: "Find a user" })).toBeVisible();
  // Search-first: nothing is listed before typing.
  await expect(page.locator(".rowlink.person")).toHaveCount(0);

  await page.getByLabel("Search users by email").fill(user.email);
  await expect(page.getByText(user.displayName)).toBeVisible();
  await page.getByText(user.displayName).click();

  await expect(page).toHaveURL(new RegExp(`/administration/access\\?user=${user.userRef}`));
  await expect(page.getByRole("heading", { name: user.displayName })).toBeVisible();
  // Scoped to the summary panel's own row - "Partnership Manager" also
  // appears in the sensitive-category panel's description text and its
  // own role-segment button above, which a page-wide text match would
  // ambiguously match too.
  const baseRoleRow = page.locator(".kv", { has: page.getByText("Base role", { exact: true }) });
  await expect(baseRoleRow.getByText("Partnership Manager")).toBeVisible();

  // Deny a module via its tick-mark column; effective result and count update.
  await expect(page.locator(".kv", { has: page.getByText("Effective modules", { exact: true }) })).toBeVisible();
  const effectiveModulesBefore = await page.locator(".kv", { has: page.getByText("Effective modules") }).locator("b").innerText();

  await page.getByLabel("Discovery: set to Deny").click();
  await expect(page.getByLabel("Discovery: set to Deny")).toHaveAttribute("aria-pressed", "true");
  const discoveryRow = page.locator("table tbody tr", { has: page.getByText("Discovery", { exact: true }) }).first();
  await expect(discoveryRow.getByText("Denied")).toBeVisible();
  await expect(discoveryRow.getByText("Explicit deny")).toBeVisible();

  const effectiveModulesAfter = await page.locator(".kv", { has: page.getByText("Effective modules") }).locator("b").innerText();
  expect(effectiveModulesAfter).not.toBe(effectiveModulesBefore);

  // Expand the denied module - its actions show "Module denied", not
  // their own role/override source, since effective action access
  // requires effective module access.
  await page.getByLabel("Expand Discovery actions").click();
  await expect(page.getByText("Module denied").first()).toBeVisible();

  // Re-allow the module, then set one specific action override
  // independent of the module's own (now-inherited) baseline.
  await page.getByLabel("Discovery: set to Inherit").click();
  const actionDenyButton = page.getByLabel("Discovery: Convert lead: set to Deny");
  await expect(actionDenyButton).toBeVisible();
  await actionDenyButton.click();
  await expect(actionDenyButton).toHaveAttribute("aria-pressed", "true");

  // Persistence after a real refresh - the URL carries the selection
  // (the matrix's own expand/collapse state is local UI state and
  // resets, same as any other module's local UI never surviving a
  // reload - the override VALUE itself is what must persist).
  await page.reload();
  await expect(page.getByRole("heading", { name: user.displayName })).toBeVisible();
  await page.getByLabel("Expand Discovery actions").click();
  await expect(page.getByLabel("Discovery: Convert lead: set to Deny")).toHaveAttribute("aria-pressed", "true");

  // Direct API/enforcement proof: the effective-access DTO the trusted
  // server returns now reflects the override - not a client-only
  // interpretation.
  const dtoResponse = await page.request.get(`/api/administration/users/${user.userRef}/effective-access`);
  const dto = await dtoResponse.json();
  expect(dto.modules.discovery.actions.convert_lead.effective).toEqual({ value: false, source: "override_deny" });

  // Clean up the action override so it doesn't affect other tests.
  await page.getByLabel("Discovery: Convert lead: set to Inherit").click();
});

test("Access matrix bulk operations: Allow All, Deny All, and Reset All to Role Defaults, each confirmed and audited", async ({ page }) => {
  const user = await provisionUser(page, { displayName: "E2E Bulk User", role: "viewer" });

  await page.goto(`/administration/access?user=${user.userRef}`);
  await expect(page.getByRole("heading", { name: user.displayName })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Deny All Modules" }).click();
  await expect(page.getByLabel("Dashboard: set to Deny")).toHaveAttribute("aria-pressed", "true");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Allow All Modules" }).click();
  await expect(page.getByLabel("Dashboard: set to Allow")).toHaveAttribute("aria-pressed", "true");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset All to Role Defaults" }).click();
  await expect(page.getByLabel("Dashboard: set to Inherit")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/administration/audit");
  // Same reasoning as the other audit-visibility test: page forward
  // (bounded) since the trail is newest-first and parallel tests write
  // events concurrently.
  const auditRow = page.locator("table tbody tr").filter({ hasText: user.email }).filter({ hasText: "mode" });
  const nextAuditPage = page.locator("nav[aria-label='Pagination']").getByRole("button", { name: "Next" });
  for (let guard = 0; guard < 20 && (await auditRow.count()) === 0 && (await nextAuditPage.isEnabled().catch(() => false)); guard += 1) {
    await nextAuditPage.click();
  }
  await expect(auditRow.first()).toBeVisible();
});

test("an opaque, tampered userRef on the Access page's effective-access route is rejected, not crashed", async ({ page }) => {
  const response = await page.request.get("/api/administration/users/this-token-does-not-exist-12345/effective-access");
  expect(response.status()).toBe(404);
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

  test("Access page search and matrix remain usable at mobile width", async ({ page }) => {
    const user = await provisionUser(page, { displayName: "E2E Mobile Matrix User", role: "analyst" });

    await page.goto("/administration/access");
    await page.getByLabel("Search users by email").fill(user.email);
    await expect(page.getByText(user.displayName)).toBeVisible();
    await page.getByText(user.displayName).click();

    await expect(page.getByRole("heading", { name: user.displayName })).toBeVisible();
    const denyButton = page.getByLabel("Reports: set to Deny");
    await denyButton.scrollIntoViewIfNeeded();
    await denyButton.click();
    await expect(denyButton).toHaveAttribute("aria-pressed", "true");

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    await page.getByLabel("Reports: set to Inherit").click();
  });
});
