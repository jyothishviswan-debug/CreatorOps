import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// This file runs in the default `chromium` project, pre-authenticated as
// admin@creatorops.com (Super Admin, GLOBAL scope) via the shared
// storageState - same baseline as partners.spec.ts/discovery.spec.ts.
// Tests that need a different identity call signInAs explicitly.
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

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// VendorForm/VendorOwnerTeamPanel render fields with the shared
// `@/ui/Form` Field component, whose <label> is a plain sibling of the
// input (no htmlFor/id) - same locator idiom partners.spec.ts already
// uses to work around it.
function formField(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(".field").filter({ has: page.locator("label", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) }) }).locator("input, select, textarea");
}

type VendorApi = { vendorRef: string; version: number; displayName: string; status: string };

async function createVendorViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<VendorApi> {
  const response = await page.request.post("/api/vendors", {
    data: { displayName: uniqueName("E2E Vendor"), vendorType: "AGENCY", ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as VendorApi;
}

type PartnerApi = { partnerRef: string; version: number; displayName: string };

async function createPartnerViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<PartnerApi> {
  const response = await page.request.post("/api/partners", {
    data: { displayName: uniqueName("E2E Partner"), ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as PartnerApi;
}

type LinkApi = { vendorPartnerLinkRef: string; version: number; partnerRef: string; vendorRef: string };

async function createLinkViaApi(page: Page, vendorRef: string, overrides: Record<string, unknown> = {}): Promise<LinkApi> {
  const partner = overrides.partnerRef ? null : await createPartnerViaApi(page);
  const response = await page.request.post(`/api/vendors/${vendorRef}/links`, {
    data: { partnerRef: partner?.partnerRef, relationshipType: "REPRESENTATION", effectiveFrom: "2026-01-01", ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as LinkApi;
}

// ---- Overview / Workspace ----

test.describe("Overview", () => {
  test("shows real scoped data, not fabricated totals", async ({ page }) => {
    await page.goto("/vendors");
    await expect(page.locator("h1")).toHaveText("Vendors");
    await expect(page.getByText("Real scoped emulator data")).toBeVisible();
    await expect(page.locator(".ov-kpi-label", { hasText: "Total vendors" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Vendor Status" })).toBeVisible();
    await expect(page.getByText("Recent Activity")).toBeVisible();
    await expect(page.getByText("Quick Actions")).toBeVisible();
    // No fabricated Campaign/Finance totals.
    await expect(page.getByText("not yet available")).toBeVisible();
  });

  test("scope changes the Overview's own counts between roles", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto("/vendors");
    const managerCount = await page.locator(".ov-kpi-value").first().innerText();

    await signInAs(page, "admin");
    await page.goto("/vendors");
    const adminCount = await page.locator(".ov-kpi-value").first().innerText();

    expect(Number(adminCount.replace(/[^0-9]/g, ""))).toBeGreaterThanOrEqual(Number(managerCount.replace(/[^0-9]/g, "")));
  });
});

test.describe("Workspace", () => {
  test("search finds a Vendor by name via a real bounded query", async ({ page }) => {
    const vendor = await createVendorViaApi(page, { displayName: uniqueName("Findable Vendor") });

    await page.goto("/vendors");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Search vendors by name").fill(vendor.displayName);
    await expect(page.getByText(vendor.displayName)).toBeVisible({ timeout: 5000 });
  });

  test("status/type/region/owner filters auto-apply via real bounded queries", async ({ page }) => {
    const vendor = await createVendorViaApi(page, { displayName: uniqueName("Filterable Vendor"), vendorType: "PAYEE_BUSINESS", regionIds: ["Goa"] });

    await page.goto("/vendors");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Search vendors by name").fill(vendor.displayName);
    await expect(page.getByText(vendor.displayName)).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Search vendors by name").fill("");
    await page.getByLabel("Filter vendor type").selectOption("PAYEE_BUSINESS");
    await page.getByRole("button", { name: "Select regions…" }).click();
    await page.getByRole("checkbox", { name: "Goa" }).check();
    await page.getByLabel("Search vendors by name").click(); // closes the dropdown via outside click
    await expect(page.getByText(vendor.displayName)).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Goa" }).click();
    await page.getByRole("checkbox", { name: "Goa" }).uncheck();
    await page.getByLabel("Search vendors by name").click();
    await page.getByLabel("Filter status").selectOption("ACTIVE");
    await expect(page.getByText(vendor.displayName)).toBeVisible({ timeout: 5000 });
  });

  test("pagination moves between real, deterministically-ordered pages", async ({ page }) => {
    await page.goto("/vendors");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible({ timeout: 5000 });
  });

  test("same-scope user can open a Vendor's Detail page directly", async ({ page }) => {
    await signInAs(page, "manager");
    // createVendor never auto-assigns ownerUid to its creator (see
    // vendor-service.ts) - a Vendor is only in scope for the actor who
    // made it if it independently satisfies a real grant. Manager holds
    // a Kerala REGION grant, so tag the new Vendor with that region to
    // prove the positive "same-scope direct access" case cleanly.
    const vendor = await createVendorViaApi(page, { displayName: uniqueName("Manager Scoped Vendor"), regionIds: ["Kerala"] });
    await page.goto(`/vendors/${vendor.vendorRef}`);
    await expect(page.locator("h1")).toHaveText(vendor.displayName);
  });

  test("cross-scope user cannot read another-scope Vendor by direct URL", async ({ page }) => {
    await signInAs(page, "viewer");
    // seed-vendor-agency (Karnataka, no owner) is outside Viewer's
    // seeded SELF/REGION grants (Kerala, South).
    await page.goto("/vendors/seed-vendor-agency");
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.getByText("You don't have permission to view this Vendor.")).toBeVisible();
  });
});

// ---- Vendor profile ----

test.describe("Vendor profile", () => {
  test("direct create lands on the real Vendor detail", async ({ page }) => {
    await page.goto("/vendors/new");
    const name = uniqueName("Created Vendor");
    await formField(page, "Business name").fill(name);
    await page.getByRole("button", { name: "Create vendor" }).click();

    await expect(page).toHaveURL(/\/vendors\/[a-f0-9-]{20,}$/);
    await expect(page.locator("h1")).toHaveText(name);
  });

  test("presents a confirmed duplicate match, a clean no-match, and an Unknown/Error lookup failure", async ({ page }) => {
    const existing = await createVendorViaApi(page, { displayName: uniqueName("Duplicate Source Vendor"), email: "duplicate-seek@example-vendor.test" });

    await page.goto("/vendors/new");
    await formField(page, "Email address").fill("duplicate-seek@example-vendor.test");
    await expect(page.getByText(/Likely duplicate found|Possible duplicate/)).toBeVisible({ timeout: 5000 });

    await formField(page, "Email address").fill(`${uniqueName("nomatch").replace(/\s+/g, "")}@example-vendor.test`);
    await expect(page.getByText("No duplicate found")).toBeVisible({ timeout: 5000 });

    await page.route("**/api/vendors/duplicate-check", (route) => route.abort());
    await formField(page, "Phone number").fill("+91 90000 09999");
    await expect(page.getByText("Duplicate check unavailable")).toBeVisible({ timeout: 5000 });

    void existing;
  });

  test("collects no PAN/GST/bank field on the ordinary create form", async ({ page }) => {
    await page.goto("/vendors/new");
    const labels = (await page.locator("label").allTextContents()).map((l) => l.toLowerCase());
    for (const term of ["pan", "gst", "bank", "ifsc", "aadhaar"]) {
      expect(labels.some((l) => l.includes(term))).toBe(false);
    }
  });

  test("ordinary edit, and a stale write is handled explicitly", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("button", { name: "Edit profile" }).click();
    await formField(page, "Business name").fill(`${vendor.displayName} Updated`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("h1")).toHaveText(`${vendor.displayName} Updated`, { timeout: 5000 });

    await page.getByRole("button", { name: "Edit profile" }).click();
    const outOfBand = await page.request.patch(`/api/vendors/${vendor.vendorRef}`, {
      data: { displayName: `${vendor.displayName} Out Of Band`, expectedVersion: vendor.version + 1 },
    });
    expect(outOfBand.ok()).toBeTruthy();

    await formField(page, "Business name").fill(`${vendor.displayName} Stale Attempt`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("This Vendor was changed elsewhere.")).toBeVisible({ timeout: 5000 });
  });

  test("owner/team change uses its own authorized path", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("button", { name: "Change" }).click();
    // VendorOwnerTeamPanel's outer wrapper is itself a ".field full" div,
    // so the generic formField() helper's ".field" filter also matches
    // it (containing BOTH the owner picker's search input and the Teams
    // input as descendants) - Teams is the only plain text input in this
    // editing panel (the owner picker's is type="search").
    await page.locator('.field.full input[type="text"]').fill("south-programmes");
    await page.getByRole("button", { name: "Save owner/team" }).click();
    await expect(page.getByText("south-programmes")).toBeVisible({ timeout: 5000 });
  });
});

// ---- Relationships ----

test.describe("Relationships", () => {
  test("links one Vendor to one Partner", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    const partner = await createPartnerViaApi(page);

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await page.getByRole("button", { name: "Link a Partner" }).click();
    await page.getByPlaceholder("Search partners by name…").fill(partner.displayName);
    await page.getByRole("button", { name: partner.displayName }).click();
    await page.getByRole("button", { name: "Link Partner" }).click();

    await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Representation")).toBeVisible();
  });

  test("one Vendor can be linked to multiple Partners at once (the Vendor side is unrestricted)", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    const partnerA = await createPartnerViaApi(page);
    const partnerB = await createPartnerViaApi(page);
    await createLinkViaApi(page, vendor.vendorRef, { partnerRef: partnerA.partnerRef });
    await createLinkViaApi(page, vendor.vendorRef, { partnerRef: partnerB.partnerRef });

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await expect(page.getByText(partnerA.displayName)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(partnerB.displayName)).toBeVisible();
  });

  test("a Partner may have at most one active Vendor at a time (company policy) - a second active Vendor is rejected until the first ends", async ({ page }) => {
    const vendorA = await createVendorViaApi(page, { displayName: uniqueName("First Vendor") });
    const vendorB = await createVendorViaApi(page, { displayName: uniqueName("Second Vendor") });
    const partner = await createPartnerViaApi(page);
    await createLinkViaApi(page, vendorA.vendorRef, { partnerRef: partner.partnerRef });

    // Attempting to link a second, DIFFERENT Vendor while the first is
    // still active is rejected server-side - never silently allowed.
    const rejected = await page.request.post(`/api/vendors/${vendorB.vendorRef}/links`, {
      data: { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: "2026-01-01" },
    });
    expect(rejected.ok()).toBeFalsy();
    expect(rejected.status()).toBe(409);
    const body = (await rejected.json()) as { error: string };
    expect(body.error).toContain(vendorA.displayName);

    // The UI surfaces this the same way - via the ordinary error banner
    // on the Link Partner form.
    await page.goto(`/vendors/${vendorB.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await page.getByRole("button", { name: "Link a Partner" }).click();
    await page.getByPlaceholder("Search partners by name…").fill(partner.displayName);
    await page.getByRole("button", { name: partner.displayName }).click();
    await page.getByRole("button", { name: "Link Partner" }).click();
    await expect(page.getByText(/already has an active Vendor relationship/)).toBeVisible({ timeout: 5000 });

    // Ending the first relationship frees the Partner for vendorB.
    await page.goto(`/vendors/${vendorA.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await page.getByRole("button", { name: "End relationship" }).first().click();
    await page.getByRole("button", { name: "End relationship" }).nth(1).click();
    await expect(page.locator(".pill", { hasText: "Ended" })).toBeVisible({ timeout: 5000 });

    const allowed = await page.request.post(`/api/vendors/${vendorB.vendorRef}/links`, {
      data: { partnerRef: partner.partnerRef, relationshipType: "MANAGEMENT", effectiveFrom: "2026-01-01" },
    });
    expect(allowed.ok()).toBeTruthy();
  });

  test("effectiveFrom is required to link, and an end date before it is rejected", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    const partner = await createPartnerViaApi(page);

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await page.getByRole("button", { name: "Link a Partner" }).click();
    await page.getByPlaceholder("Search partners by name…").fill(partner.displayName);
    await page.getByRole("button", { name: partner.displayName }).click();
    // The date <input> defaults to today and carries a native `required`
    // attribute - clearing it and submitting must never create a link
    // with no effective date (the browser blocks the submit natively).
    await formField(page, "Effective from").fill("");
    await page.getByRole("button", { name: "Link Partner" }).click();
    await expect(page.getByRole("button", { name: "Link a Partner" })).toHaveCount(0); // form is still open, not replaced by a created row
    await formField(page, "Effective from").fill("2026-06-01");
    await page.getByRole("button", { name: "Link Partner" }).click();
    await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "End relationship" }).click();
    await page.locator('input[type="date"]').fill("2026-01-01"); // before effectiveFrom
    await page.getByRole("button", { name: "End relationship" }).nth(1).click();
    await expect(page.getByText(/effectiveTo cannot be before effectiveFrom/)).toBeVisible({ timeout: 5000 });
  });

  test("ending a relationship preserves the historical row, and it can be restored", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    const link = await createLinkViaApi(page, vendor.vendorRef);

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    // The row's own "End relationship" button opens the confirm banner,
    // which itself contains a second "End relationship" (confirm)
    // button - both are on screen at once once opened.
    await page.getByRole("button", { name: "End relationship" }).first().click();
    await page.getByRole("button", { name: "End relationship" }).nth(1).click();
    await expect(page.locator(".pill", { hasText: "Ended" })).toBeVisible({ timeout: 5000 });

    // The row is still on file, never deleted.
    const stillVisible = await page.request.get(`/api/vendors/${vendor.vendorRef}/links`);
    const links = (await stillVisible.json()) as { vendorPartnerLinkRef: string; status: string }[];
    expect(links.some((l) => l.vendorPartnerLinkRef === link.vendorPartnerLinkRef && l.status === "ENDED")).toBe(true);

    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible({ timeout: 5000 });
  });

  test("Partner picker is scope-safe: never leaks a cross-scope Partner via search", async ({ page }) => {
    await signInAs(page, "manager");
    // Tagged Kerala so Manager (who holds a Kerala REGION grant) can
    // directly reach this Vendor's own detail page - see the "same-scope
    // user can open a Vendor's Detail page directly" test above for why
    // creation alone never grants the creator scope.
    const vendor = await createVendorViaApi(page, { regionIds: ["Kerala"] });

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await page.getByRole("button", { name: "Link a Partner" }).click();
    // seed-partner-inactive (Tamil Nadu, owned by Analyst) is outside
    // Manager's own Partner-list scope (Kerala/Maharashtra/South/West
    // regions, kerala-programmes team, and an explicit grant naming only
    // creator-house) for this direct search - never surfaced. Deliberately
    // NOT creator-house: Manager holds a real PARTNER-type grant naming
    // it specifically (see seed-access-data.ts), so it IS in scope.
    await page.getByPlaceholder("Search partners by name…").fill("Arjun Balan");
    // VendorPartnerPicker renders a typographic apostrophe (&rsquo; / U+2019),
    // not a plain ASCII "'" - matched loosely here to avoid depending on
    // the exact character.
    await expect(page.getByText(/No Partners.*authorized to see match/)).toBeVisible({ timeout: 5000 });
  });

  test("Partner-side relationship slice shows this Partner's own rows, never a Vendor's unrelated portfolio", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    const partnerA = await createPartnerViaApi(page);
    const partnerB = await createPartnerViaApi(page);
    await createLinkViaApi(page, vendor.vendorRef, { partnerRef: partnerA.partnerRef });
    await createLinkViaApi(page, vendor.vendorRef, { partnerRef: partnerB.partnerRef });

    await page.goto(`/partners/${partnerA.partnerRef}`);
    await page.getByRole("tab", { name: "Relationships" }).click();
    await expect(page.getByText(vendor.displayName)).toBeVisible({ timeout: 5000 });
    // Only this Partner's own row - never partnerB's relationship leaking here.
    await expect(page.getByText(partnerB.displayName)).toHaveCount(0);
  });

  test("a Partner-scope actor without direct Vendor scope sees the safe row with no active deep link, and no client-side Vendor probe fires", async ({ page }) => {
    // creator-house IS in Manager's Partner scope - via a real explicit
    // PARTNER-type grant naming it specifically (see seed-access-data.ts),
    // not a region/owner match. It's linked to seed-vendor-agency
    // (Karnataka), which is OUTSIDE Manager's own Vendor scope
    // (Kerala/Maharashtra/South/West regions, kerala-programmes team) -
    // the visible Partner relationship must never bridge into direct
    // Vendor access (Step 8A section 7's rule, in this direction).
    await signInAs(page, "manager");
    // Step 8B.1 REVISED section 8: canOpenVendor is server-computed on
    // the /vendor-links response itself - the browser must never issue a
    // per-row GET to /api/vendors/{ref} just to decide whether to render
    // "Open Vendor".
    const vendorProbes: string[] = [];
    await page.route(/\/api\/vendors\/(?!links)[^/]+$/, (route) => {
      vendorProbes.push(route.request().url());
      route.continue();
    });

    await page.goto("/partners/creator-house");
    await page.getByRole("tab", { name: "Relationships" }).click();
    await expect(page.getByText("Northline Talent Agency")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("link", { name: "Open Vendor" })).toHaveCount(0);
    expect(vendorProbes).toEqual([]);
  });

  test("a Partner-scope actor WITH direct Vendor scope sees a real Open Vendor link, still with no client-side probe", async ({ page }) => {
    await signInAs(page, "head"); // Head has GLOBAL-ish region coverage including Karnataka
    const vendorProbes: string[] = [];
    await page.route(/\/api\/vendors\/(?!links)[^/]+$/, (route) => {
      vendorProbes.push(route.request().url());
      route.continue();
    });

    await page.goto("/partners/creator-house");
    await page.getByRole("tab", { name: "Relationships" }).click();
    await expect(page.getByRole("link", { name: "Open Vendor" })).toBeVisible({ timeout: 5000 });
    expect(vendorProbes).toEqual([]); // canOpenVendor came pre-computed on the list response, not a probe
  });
});

// ---- Lifecycle ----

test.describe("Lifecycle / governance", () => {
  test("ACTIVE <-> INACTIVE toggles without a reason", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    await page.goto(`/vendors/${vendor.vendorRef}`);

    await page.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.locator(".pill", { hasText: "Inactive" })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible({ timeout: 5000 });
  });

  test("Archive requires a reason, and an active-link dependency blocks it without leaving Confirm reusable as safe", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    await createLinkViaApi(page, vendor.vendorRef);

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByLabel(/Reason for archiving/).fill("E2E archive attempt with an active relationship.");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("Not ready.")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/active Partner relationship/)).toBeVisible();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible();
  });

  test("restore returns to exact previous status, and never changes Partner state/version", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    const vendor = await createVendorViaApi(page);
    await page.request.post(`/api/vendors/${vendor.vendorRef}/status`, { data: { status: "INACTIVE", expectedVersion: vendor.version } });

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByLabel(/Reason for archiving/).fill("E2E archive from Inactive.");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "Archived" })).toBeVisible({ timeout: 5000 });

    const partnerBefore = await page.request.get(`/api/partners/${partner.partnerRef}`);
    const partnerVersionBefore = (await partnerBefore.json()).version;

    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByRole("button", { name: "Confirm restore" }).click();
    await expect(page.locator(".pill", { hasText: "Inactive" })).toBeVisible({ timeout: 5000 });

    const partnerAfter = await page.request.get(`/api/partners/${partner.partnerRef}`);
    const partnerVersionAfter = (await partnerAfter.json()).version;
    expect(partnerVersionAfter).toBe(partnerVersionBefore);
  });
});

// ---- Restricted identity ----

test.describe("Restricted identity", () => {
  test("denied without vendor_payment_details", async ({ page }) => {
    await signInAs(page, "manager");
    // seed-vendor-inactive is Kerala - inside Manager's seeded REGION
    // grants, so the detail page itself is reachable; Manager holds no
    // vendor_payment_details sensitive grant (see seed-access-data.ts),
    // so only the restricted-identity tab itself is denied.
    await page.goto("/vendors/seed-vendor-inactive");
    await page.getByRole("tab", { name: "Restricted Identity" }).click();
    await page.getByRole("button", { name: "View / manage restricted identity" }).click();
    await expect(page.getByText("Restricted.")).toBeVisible({ timeout: 5000 });
  });

  test("allowed with explicit sensitive access, click-to-load with no unauthorized prefetch, and no leakage on the ordinary page", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/vendors/seed-vendor-agency");

    // Ordinary Overview must never contain restricted values.
    await expect(page.getByText("ABCDE1111F")).toHaveCount(0);
    await expect(page.getByText("29ABCDE1111F1Z5")).toHaveCount(0);

    await page.getByRole("tab", { name: "Restricted Identity" }).click();
    // Still idle - no fetch happened merely by opening the tab.
    await expect(page.getByRole("button", { name: "View / manage restricted identity" })).toBeVisible();

    await page.getByRole("button", { name: "View / manage restricted identity" }).click();
    await expect(page.getByLabel("PAN / tax ID")).toHaveValue("ABCDE1111F", { timeout: 5000 });
    await expect(page.getByLabel("GST number")).toHaveValue("29ABCDE1111F1Z5");
  });

  test("create/update supported restricted fields, and a same-GST collision is presented safely", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Restricted Identity" }).click();
    await page.getByRole("button", { name: "View / manage restricted identity" }).click();

    await formField(page, "PAN / tax ID").fill("PANEX1234E");
    await page.getByLabel("GST applicable").check();
    // seed-vendor-agency's own seeded GST - a real collision against a
    // DIFFERENT Vendor.
    await formField(page, "GST number").fill("29ABCDE1111F1Z5");
    await page.getByRole("button", { name: "Save restricted identity" }).click();
    await expect(page.getByText(/already on file for another Vendor/)).toBeVisible({ timeout: 5000 });

    await formField(page, "GST number").fill("29PANEX1234E1Z9");
    await page.getByRole("button", { name: "Save restricted identity" }).click();
    await expect(page.getByText(/already on file for another Vendor/)).toHaveCount(0);
  });
});

// ---- Truthful future context ----

test.describe("Truthful future context", () => {
  test("payee context shows only the active relationship explicitly marked payeeRole, and Agreements/Finance are shown as unavailable, not fabricated", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    // Not marked as payee - representation only, so it must NOT appear
    // in the Payee/Commercial Context panel (Step 8B.1 REVISED section 4:
    // an active relationship without payeeRole means this Vendor is not
    // the one handling that Partner's payments).
    await createLinkViaApi(page, vendor.vendorRef, { payeeRole: false });

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
    await expect(page.getByText("No active payee relationships")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Not yet built").first()).toBeVisible();
    for (const label of ["Agreements", "Payables", "Invoices", "Payments"]) {
      await expect(page.getByRole("heading", { name: label })).toBeVisible();
    }

    // A DIFFERENT relationship explicitly marked as the payee DOES appear.
    const payeeLink = await createLinkViaApi(page, vendor.vendorRef, { payeeRole: true });
    await page.reload();
    await page.getByRole("tab", { name: "Payee / Commercial Context" }).click();
    await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible({ timeout: 5000 });
    void payeeLink;
  });
});

// ---- History ----

test.describe("History", () => {
  test("shows material events for a real Vendor created through the trusted service", async ({ page }) => {
    const vendor = await createVendorViaApi(page);
    await page.goto(`/vendors/${vendor.vendorRef}`);
    await page.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.locator(".pill", { hasText: "Inactive" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Vendor created")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Status changed")).toBeVisible();
  });
});

// ---- Mobile ----

test.describe("Mobile", () => {
  test("Vendor detail and relationship management remain usable at 390×844, no content overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const vendor = await createVendorViaApi(page);
    await createLinkViaApi(page, vendor.vendorRef);

    await page.goto("/vendors");
    await expect(page.locator("h1")).toHaveText("Vendors");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.goto(`/vendors/${vendor.vendorRef}`);
    await expect(page.locator("h1")).toHaveText(vendor.displayName);
    await expect(page.locator(".workflow")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("tab", { name: "Partner Relationships" }).click();
    await expect(page.getByRole("button", { name: "Link a Partner" })).toBeVisible({ timeout: 5000 });
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
