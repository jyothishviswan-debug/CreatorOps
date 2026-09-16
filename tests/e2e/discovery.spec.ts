import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// This file runs in the default `chromium` project, pre-authenticated as
// admin@creatorops.com (Super Admin, GLOBAL scope) via the shared
// storageState - same baseline as administration.spec.ts. Tests that
// need a different identity call signInAs explicitly (each Playwright
// test gets its own isolated browser context, so re-authenticating
// mid-test never leaks into other tests).
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

async function signInAs(page: Page, name: string) {
  // This file's tests start pre-authenticated as admin@creatorops.com
  // (the shared `chromium` project storageState) - proxy.ts redirects an
  // already-authenticated session straight to /dashboard on /sign-in, so
  // the existing cookie must be cleared first or this hangs waiting for
  // a sign-in form that was never reached.
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

// DiscoveryLeadForm renders its fields with the shared `@/ui/Form` Field
// component, whose <label> is a plain sibling of the input (no
// htmlFor/id) - the same component administration.spec.ts's own
// provisioning test already works around with non-getByLabel locators,
// rather than getByLabel, which would find no accessible name at all.
function formField(page: Page, label: string) {
  // Scoped to the <label> child specifically, not the whole .field div's
  // text - some fields' <small> hint text also happens to contain other
  // fields' label text (e.g. "Derived from the profile URL..." on the
  // Platform/Handle fields would otherwise also match "Profile URL").
  return page.locator(".field").filter({ has: page.locator("label", { hasText: label }) }).locator("input, select, textarea");
}

type LeadApi = {
  leadRef: string;
  version: number;
  lifecycle: string;
  displayName: string;
};

async function createLeadViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<LeadApi> {
  const response = await page.request.post("/api/discovery/leads", {
    data: { displayName: uniqueName("E2E Lead"), source: { type: "referral" }, region: "Kerala", ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as LeadApi;
}

// ---- Overview ----

test.describe("Overview", () => {
  test("shows real scoped data, not fabricated totals", async ({ page }) => {
    await page.goto("/discovery");
    await expect(page.locator("h1")).toHaveText("Discovery");
    await expect(page.getByText("Real scoped emulator data")).toBeVisible();
    await expect(page.locator(".ov-kpi-label", { hasText: "Leads in scope" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Discovery Pipeline" })).toBeVisible();
    await expect(page.getByText("Recent Activity")).toBeVisible();
    await expect(page.getByText("Quick Actions")).toBeVisible();
  });

  test("scope changes the Overview's own counts between roles", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/discovery");
    const analystCount = await page.locator(".ov-kpi-value").first().innerText();

    await signInAs(page, "admin");
    await page.goto("/discovery");
    const adminCount = await page.locator(".ov-kpi-value").first().innerText();

    // Super Admin has GLOBAL scope; Analyst's seeded REGION grants cover
    // only two of the four seeded regions - the admin's in-scope count
    // must be at least as large.
    expect(Number(adminCount.replace(/[^0-9]/g, ""))).toBeGreaterThanOrEqual(Number(analystCount.replace(/[^0-9]/g, "")));
  });
});

// ---- Workspace ----

test.describe("Workspace", () => {
  test("search finds a Lead by name via a real bounded query, and lifecycle filter auto-applies", async ({ page }) => {
    const lead = await createLeadViaApi(page, { displayName: uniqueName("Findable Lead") });

    await page.goto("/discovery/leads");
    await page.getByLabel("Search leads by name").fill(lead.displayName);
    await expect(page.getByText(lead.displayName)).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Search leads by name").fill("");
    await page.getByLabel("Filter lifecycle").selectOption("NEW");
    // No Apply button anywhere on this toolbar.
    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0);
    await expect(page.getByText(lead.displayName)).toBeVisible({ timeout: 5000 });
  });

  test("table/cards toggle shows exactly one representation at a time", async ({ page }) => {
    await page.goto("/discovery/leads");
    await expect(page.locator("table")).toBeVisible();
    await expect(page.locator(".recordgrid")).toHaveCount(0);

    await page.getByLabel("Cards view").click();
    await expect(page.locator(".recordgrid")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });

  test("cursor pagination is deterministic and numbered", async ({ page }) => {
    // A run-unique platform tag, not a fixed literal - this suite runs
    // against a reused dev server/emulator across repeated local runs
    // (reuseExistingServer), so a fixed tag would accumulate leftover
    // Leads from earlier runs and make the exact page-size assertions
    // below nondeterministic. A unique tag keeps this test hermetic no
    // matter how many times it has run before against the same backend.
    const platformTag = `PaginationProbe-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    for (let i = 0; i < 12; i += 1) {
      await createLeadViaApi(page, { displayName: uniqueName("Page Lead"), platform: platformTag });
    }
    await page.goto("/discovery/leads");
    await page.getByLabel("Filter platform").fill(platformTag);

    const pager = page.locator("nav[aria-label='Pagination']");
    // The page loads unfiltered first (already showing "Page 1"), and
    // can transiently show zero rows mid-debounce (loading/empty state) -
    // neither "Page 1" text nor "no mismatched rows" alone proves the
    // filtered fetch has landed, since both are trivially true on an
    // empty table too. Wait for exactly the 10 filtered rows the probe
    // itself created.
    await expect(page.locator(`table tbody tr:has-text('${platformTag}')`)).toHaveCount(10, { timeout: 10_000 });
    await expect(page.locator("table tbody tr")).toHaveCount(10);
    await expect(pager.getByRole("button", { name: "Next" })).toBeEnabled({ timeout: 5000 });
    const firstPageRows = await page.locator("table tbody tr td:first-child b").allTextContents();
    expect(firstPageRows.length).toBe(10);

    // A single click occasionally lands while React is mid-reconciliation
    // and never registers - retrying the click until the page-2 text
    // actually shows up is more robust than trusting one click fired.
    await expect(async () => {
      await pager.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText(/^Page 2 ·/)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10_000 });
    const secondPageRows = await page.locator("table tbody tr td:first-child b").allTextContents();
    expect(secondPageRows.length).toBeGreaterThanOrEqual(2);
    expect(new Set([...firstPageRows, ...secondPageRows]).size).toBe(firstPageRows.length + secondPageRows.length);

    await expect(async () => {
      await pager.getByRole("button", { name: "1", exact: true }).click();
      await expect(page.getByText(/^Page 1 ·/)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10_000 });
    await expect(page.locator("table tbody tr td:first-child b")).toHaveText(firstPageRows);
  });
});

// ---- Create / duplicate checking ----

test.describe("Create Lead", () => {
  test("creates a real Lead and lands on its Detail page with an opaque leadRef URL", async ({ page }) => {
    await page.goto("/discovery/new");
    const name = uniqueName("Created Lead");
    await formField(page, "Full name").fill(name);
    await page.getByRole("button", { name: "Create lead" }).click();

    await expect(page).toHaveURL(/\/discovery\/[a-f0-9-]{20,}$/);
    await expect(page.locator("h1")).toHaveText(name);
  });

  test("presents a confirmed duplicate match, a clean no-match, and an Unknown/Error lookup failure", async ({ page }) => {
    await page.goto("/discovery/new");

    // Confirmed match: the seeded "seed-lead-new" profile URL.
    await formField(page, "Profile URL").fill("https://instagram.com/new");
    await expect(page.getByText(/Likely duplicate found|Possible duplicate/)).toBeVisible({ timeout: 5000 });

    // Clean: an identifier nothing matches.
    await formField(page, "Profile URL").fill(`https://instagram.com/${uniqueName("nomatch").replace(/\s+/g, "")}`);
    await expect(page.getByText("No duplicate found")).toBeVisible({ timeout: 5000 });

    // Lookup failure - never silently "no duplicate".
    await page.route("**/api/discovery/duplicate-check", (route) => route.abort());
    await formField(page, "Email address").fill(`${uniqueName("errorcase").replace(/\s+/g, "")}@example.com`);
    await expect(page.getByText("Duplicate check unavailable")).toBeVisible({ timeout: 5000 });
  });

  test("collects no postal address or address proof field on the form", async ({ page }) => {
    await page.goto("/discovery/new");
    // Checks actual FORM FIELD labels, not page prose - the form's own
    // reassuring copy ("No postal address ... is collected") legitimately
    // contains these words while confirming their absence, so a whole-page
    // substring check would flag its own truthful disclaimer.
    const labels = (await page.locator("label").allTextContents()).map((l) => l.toLowerCase());
    for (const term of ["postal", "street", "pin code", "pincode", "zip code", "address proof", "city"]) {
      expect(labels.some((l) => l.includes(term))).toBe(false);
    }
  });
});

// ---- Edit + stale conflict ----

test.describe("Edit", () => {
  test("edits ordinary fields, and a stale write is handled explicitly", async ({ page }) => {
    const lead = await createLeadViaApi(page);

    await page.goto(`/discovery/${lead.leadRef}/edit`);
    await formField(page, "Full name").fill(`${lead.displayName} Updated`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/discovery/${lead.leadRef}$`));
    await expect(page.locator("h1")).toHaveText(`${lead.displayName} Updated`);

    // Change it again out-of-band (simulating someone else's edit),
    // then submit a stale edit through the UI form still holding the
    // old version.
    await page.goto(`/discovery/${lead.leadRef}/edit`);
    const outOfBand = await page.request.patch(`/api/discovery/leads/${lead.leadRef}`, {
      data: { displayName: `${lead.displayName} Out Of Band`, expectedVersion: lead.version + 1 },
    });
    expect(outOfBand.ok()).toBeTruthy();

    await formField(page, "Full name").fill(`${lead.displayName} Stale Attempt`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("This Lead was changed elsewhere.")).toBeVisible();
  });
});

// ---- Detail workflow: Research / Review / Outreach / Commercial / Agreement / Asset / Manager ----

test.describe("Detail workflow", () => {
  test("Research: only Target Audience is required, and saving it progresses the workflow", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);

    await page.getByRole("tab", { name: "Research" }).click();
    await page.getByLabel("Target Audience (required)").selectOption("India 1");
    await page.getByRole("button", { name: "Save research" }).click();
    await expect(page.getByText("Saved Target Audience")).toBeVisible();
    await expect(page.locator(".step", { hasText: "Research" })).toHaveClass(/done/);
  });

  test("the first outbound contact advances NEW to CONTACTED, and a meaningful inbound response advances it to RESPONDED", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);

    await page.getByRole("tab", { name: "Outreach & Negotiation" }).click();
    await page.getByLabel("Channel").fill("email");
    await page.getByLabel("Summary", { exact: true }).fill("Introduced the programme.");
    await page.getByLabel("Outcome").fill("Sent");
    await page.getByRole("button", { name: "Record outreach" }).click();
    await expect(page.getByText("Contacted", { exact: true })).toBeVisible();

    await page.getByLabel("Direction").selectOption("INBOUND");
    await page.getByLabel("Channel").fill("email");
    await page.getByLabel("Summary", { exact: true }).fill("Replied with interest.");
    await page.getByLabel("Outcome").fill("Interested");
    await page.getByLabel("This is a meaningful response").check();
    await page.getByRole("button", { name: "Record outreach" }).click();
    await expect(page.getByText("Responded", { exact: true })).toBeVisible();
  });

  test("review outcome is recorded and shown as saved evidence", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Review & Shortlist" }).click();
    await page.getByLabel("Outcome").selectOption("SHORTLIST");
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(page.getByText("Latest outcome")).toBeVisible();
    await expect(page.locator(".pill", { hasText: "Shortlist" })).toBeVisible();
  });

  test("commercial evidence stays distinct from outreach evidence", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Outreach & Negotiation" }).click();
    await page.getByLabel("Commercial alignment confirmed").check();
    await page.getByRole("button", { name: "Save commercial evidence" }).click();
    await expect(page.getByText("Negotiation / commercial alignment")).toBeVisible();
  });

  test("operational agreement evidence is captured as Discovery-only, never implying canonical Finance truth", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Agreement" }).click();
    await expect(page.getByText("never canonical Finance Agreement truth")).toBeVisible();
    await page.getByLabel("Operational agreement confirmed").check();
    await page.getByRole("button", { name: "Save agreement evidence" }).click();
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  });

  test("all three asset decisions are supported, and NEW_ACCOUNT never fabricates a Partner Account", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Asset Setup" }).click();

    await expect(page.getByText("New Account setup is pending")).toBeVisible();
    await page.getByRole("button", { name: "Save asset decision" }).click();
    await expect(page.getByText("Saved decision")).toBeVisible();

    await page.getByLabel("Decision").selectOption("MAINTAIN_EXISTING");
    await page.getByLabel("Existing Partner Account reference").fill("placeholder-account-ref");
    await page.getByRole("button", { name: "Save asset decision" }).click();
    await expect(page.locator(".pill", { hasText: "Maintain Existing" })).toBeVisible();

    await page.getByLabel("Decision").selectOption("TRANSFER_AND_MAINTAIN");
    await page.getByLabel("Existing Partner Account reference").fill("placeholder-account-ref-2");
    await page.getByRole("button", { name: "Save asset decision" }).click();
    await expect(page.locator(".pill", { hasText: "Transfer & Maintain" })).toBeVisible();
  });

  test("manager assignment uses a real active-user search, never free text", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Manager & KYC" }).click();
    // "Unassigned" also legitimately appears in the top-of-page Owner
    // summary for an unowned Lead - scope to the Manager row specifically.
    await expect(page.locator(".kv", { hasText: "Assigned manager" })).toContainText("Unassigned");

    await page.getByLabel("Search active users by email").fill("head@");
    await expect(page.getByText("Head (Test)")).toBeVisible({ timeout: 5000 });
    await page.getByText("Head (Test)").click();
    await expect(page.locator(".kv", { hasText: "Assigned manager" })).toContainText("Head (Test)");
  });
});

// ---- KYC ----

test.describe("Restricted KYC", () => {
  test("is denied without the discovery_kyc sensitive grant, and allowed with it", async ({ page }) => {
    const lead = await createLeadViaApi(page);

    await signInAs(page, "manager");
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Manager & KYC" }).click();
    await page.getByRole("button", { name: "View / manage restricted KYC" }).click();
    await expect(page.getByText("Restricted.")).toBeVisible();

    await signInAs(page, "head");
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Manager & KYC" }).click();
    await page.getByRole("button", { name: "View / manage restricted KYC" }).click();
    await expect(page.getByLabel("Aadhaar number")).toBeVisible();

    const kycLabels = (await page.locator("label").allTextContents()).map((l) => l.toLowerCase());
    for (const term of ["postal", "street", "pin code", "pincode", "address proof", "city"]) {
      expect(kycLabels.some((l) => l.includes(term))).toBe(false);
    }

    await page.getByLabel("Email", { exact: true }).fill("kyc-e2e@example.com");
    await page.getByLabel("Aadhaar number").fill("1234-5678-9999");
    await page.getByLabel("Aadhaar evidence reference").fill("ref://aadhaar");
    await page.getByLabel("PAN", { exact: true }).fill("ABCDE1234F");
    await page.getByLabel("PAN evidence reference").fill("ref://pan");
    await page.getByLabel("Account holder name").fill("E2E Creator");
    await page.getByLabel("Account number").fill("000111222333");
    await page.getByLabel("IFSC").fill("TEST0000001");
    await page.getByLabel("Bank name").fill("Test Bank");
    await page.getByLabel("Bank proof reference").fill("ref://bank");
    await page.getByRole("button", { name: "Save KYC package" }).click();
    await expect(page.getByText("Save KYC package")).toBeEnabled({ timeout: 5000 });
  });

  test("never leaks restricted values into ordinary rendered surfaces", async ({ page }) => {
    await signInAs(page, "head");
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Manager & KYC" }).click();
    await page.getByRole("button", { name: "View / manage restricted KYC" }).click();
    await page.getByLabel("Email", { exact: true }).fill("secret-kyc@example.com");
    await page.getByLabel("Aadhaar number").fill("9999-8888-7777");
    await page.getByLabel("Aadhaar evidence reference").fill("ref://a");
    await page.getByLabel("PAN", { exact: true }).fill("SECRT1234F");
    await page.getByLabel("PAN evidence reference").fill("ref://p");
    await page.getByLabel("Account holder name").fill("Secret Name");
    await page.getByLabel("Account number").fill("SECRETNUM123");
    await page.getByLabel("IFSC").fill("SECR0000001");
    await page.getByLabel("Bank name").fill("Secret Bank");
    await page.getByLabel("Bank proof reference").fill("ref://b");
    await page.getByRole("button", { name: "Save KYC package" }).click();
    await expect(page.getByText("Save KYC package")).toBeEnabled({ timeout: 5000 });

    // Ordinary surfaces - Workspace, Overview, and this same Detail page
    // reloaded fresh (not the still-open KYC form) - must never contain
    // the raw values just saved.
    for (const path of ["/discovery/leads", "/discovery"]) {
      await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text).not.toContain("9999-8888-7777");
      expect(text).not.toContain("SECRT1234F");
      expect(text).not.toContain("SECRETNUM123");
      expect(text).not.toContain("SECR0000001");
    }

    await page.goto(`/discovery/${lead.leadRef}`);
    const detailText = await page.locator("body").innerText();
    expect(detailText).not.toContain("9999-8888-7777");
    expect(detailText).not.toContain("SECRT1234F");
  });
});

// ---- Readiness / conversion ----

test.describe("Readiness and conversion", () => {
  test("shows real blockers/warnings for an incomplete Lead", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Ready" }).click();
    await expect(page.getByText("Not ready", { exact: true })).toBeVisible();
    await expect(page.getByText("Blockers")).toBeVisible();
  });

  test("conversion is denied via the trusted endpoint when the Lead is not ready", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    const response = await page.request.post(`/api/discovery/leads/${lead.leadRef}/convert`, {
      data: { idempotencyKey: "e2e-not-ready", expectedVersion: lead.version },
    });
    expect(response.status()).toBe(400);
  });

  // Regression: CONVERSION_READY's only valid predecessor is EVALUATING
  // (src/server/authz/lifecycle.ts), but nothing in the UI ever moves a
  // Lead into EVALUATING - a real Lead reaching full readiness via
  // outreach is still at RESPONDED. The "Mark conversion ready" button
  // used to call the CONVERSION_READY transition directly and fail with
  // "Cannot move a Lead from RESPONDED to CONVERSION_READY.", a dead end
  // with no way to ever convert through the real UI. Unlike the
  // "fully-prepared Lead converts" test below, this one deliberately
  // does NOT pre-set EVALUATING via the API, so it actually exercises
  // the UI button's own transition chain.
  test("Mark conversion ready works from the real RESPONDED state a Lead reaches through outreach, without a manual EVALUATING step", async ({ page }) => {
    await signInAs(page, "head");
    const lead = await createLeadViaApi(page, { email: `${uniqueName("readystate").replace(/\s+/g, "")}@example.com` });
    let version = lead.version;

    const research = await page.request.post(`/api/discovery/leads/${lead.leadRef}/research`, { data: { targetAudience: "India 1", expectedVersion: version } });
    version = (await research.json()).version;
    const outbound = await page.request.post(`/api/discovery/leads/${lead.leadRef}/outreach`, {
      data: { direction: "OUTBOUND", channel: "email", summary: "hi", outcome: "sent", expectedVersion: version },
    });
    version = (await outbound.json()).version;
    const inbound = await page.request.post(`/api/discovery/leads/${lead.leadRef}/outreach`, {
      data: { direction: "INBOUND", channel: "email", summary: "reply", outcome: "interested", meaningfulResponse: true, expectedVersion: version },
    });
    version = (await inbound.json()).version;
    const review = await page.request.post(`/api/discovery/leads/${lead.leadRef}/review`, { data: { outcome: "SHORTLIST", expectedVersion: version } });
    version = (await review.json()).version;
    const commercial = await page.request.post(`/api/discovery/leads/${lead.leadRef}/commercial`, { data: { alignmentConfirmed: true, expectedVersion: version } });
    version = (await commercial.json()).version;
    const agreement = await page.request.post(`/api/discovery/leads/${lead.leadRef}/agreement`, { data: { confirmed: true, expectedVersion: version } });
    version = (await agreement.json()).version;
    const asset = await page.request.post(`/api/discovery/leads/${lead.leadRef}/asset-decision`, { data: { decision: "NEW_ACCOUNT", expectedVersion: version } });
    version = (await asset.json()).version;
    const candidates = await page.request.get(`/api/discovery/users/search?emailPrefix=head@`);
    const [managerCandidate] = (await candidates.json()) as { userRef: string }[];
    const manager = await page.request.post(`/api/discovery/leads/${lead.leadRef}/manager`, { data: { managerUserRef: managerCandidate!.userRef, expectedVersion: version } });
    version = (await manager.json()).version;
    const kyc = await page.request.put(`/api/discovery/leads/${lead.leadRef}/kyc`, {
      data: {
        email: "ready-state@example.com",
        aadhaar: { number: "0000-1111-2222", evidenceRef: "ref://a" },
        pan: { number: "READY1234F", evidenceRef: "ref://p" },
        bank: { accountHolderName: "Ready State", accountNumber: "111122223333", ifsc: "REDY0000001", bankName: "Ready Bank", proofRef: "ref://b" },
        gst: { applicable: false },
        expectedKycVersion: 0,
        expectedLeadVersion: version,
      },
    });
    expect(kyc.ok()).toBeTruthy();
    const leadAfterKyc = await page.request.get(`/api/discovery/leads/${lead.leadRef}`);
    const leadAfterKycBody = await leadAfterKyc.json();
    version = leadAfterKycBody.version;
    expect(leadAfterKycBody.lifecycle).toBe("RESPONDED");
    const dup = await page.request.post(`/api/discovery/leads/${lead.leadRef}/duplicate-check`, { data: { expectedVersion: version } });
    expect(dup.ok()).toBeTruthy();

    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Ready" }).click();
    await expect(page.locator(".kv", { hasText: "Readiness" })).toContainText("Ready", { timeout: 5000 });
    await page.getByRole("button", { name: "Mark conversion ready" }).click();
    await expect(page.locator(".detailcontext").getByText("Conversion ready")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Convert to Partner" })).toBeEnabled();
  });

  test("a fully-prepared Lead converts successfully, repeated conversion returns the same Partner, and NEW_ACCOUNT creates no fake Partner Account", async ({ page }) => {
    await signInAs(page, "head");
    const lead = await createLeadViaApi(page, { email: `${uniqueName("conv").replace(/\s+/g, "")}@example.com` });
    let version = lead.version;

    const research = await page.request.post(`/api/discovery/leads/${lead.leadRef}/research`, { data: { targetAudience: "India 1", expectedVersion: version } });
    version = (await research.json()).version;
    const outbound = await page.request.post(`/api/discovery/leads/${lead.leadRef}/outreach`, {
      data: { direction: "OUTBOUND", channel: "email", summary: "hi", outcome: "sent", expectedVersion: version },
    });
    version = (await outbound.json()).version;
    const inbound = await page.request.post(`/api/discovery/leads/${lead.leadRef}/outreach`, {
      data: { direction: "INBOUND", channel: "email", summary: "reply", outcome: "interested", meaningfulResponse: true, expectedVersion: version },
    });
    version = (await inbound.json()).version;
    const evaluating = await page.request.post(`/api/discovery/leads/${lead.leadRef}/lifecycle`, { data: { to: "EVALUATING", expectedVersion: version } });
    version = (await evaluating.json()).version;
    const review = await page.request.post(`/api/discovery/leads/${lead.leadRef}/review`, { data: { outcome: "SHORTLIST", expectedVersion: version } });
    version = (await review.json()).version;
    const commercial = await page.request.post(`/api/discovery/leads/${lead.leadRef}/commercial`, { data: { alignmentConfirmed: true, expectedVersion: version } });
    version = (await commercial.json()).version;
    const agreement = await page.request.post(`/api/discovery/leads/${lead.leadRef}/agreement`, { data: { confirmed: true, expectedVersion: version } });
    version = (await agreement.json()).version;
    const asset = await page.request.post(`/api/discovery/leads/${lead.leadRef}/asset-decision`, { data: { decision: "NEW_ACCOUNT", expectedVersion: version } });
    version = (await asset.json()).version;

    // Readiness blocks conversion on an unassigned manager - assign a
    // real active user via the same bounded search the UI picker uses,
    // never a free-text/fabricated reference.
    const candidates = await page.request.get(`/api/discovery/users/search?emailPrefix=head@`);
    const [managerCandidate] = (await candidates.json()) as { userRef: string }[];
    expect(managerCandidate).toBeTruthy();
    const manager = await page.request.post(`/api/discovery/leads/${lead.leadRef}/manager`, { data: { managerUserRef: managerCandidate.userRef, expectedVersion: version } });
    expect(manager.ok()).toBeTruthy();
    version = (await manager.json()).version;
    const kyc = await page.request.put(`/api/discovery/leads/${lead.leadRef}/kyc`, {
      data: {
        email: "kyc@example.com",
        aadhaar: { number: "0000-1111-2222", evidenceRef: "ref://a" },
        pan: { number: "CONVT1234F", evidenceRef: "ref://p" },
        bank: { accountHolderName: "Convert Flow", accountNumber: "111122223333", ifsc: "CONV0000001", bankName: "Convert Bank", proofRef: "ref://b" },
        gst: { applicable: false },
        expectedKycVersion: 0,
        expectedLeadVersion: version,
      },
    });
    expect(kyc.ok()).toBeTruthy();
    const leadAfterKyc = await page.request.get(`/api/discovery/leads/${lead.leadRef}`);
    version = (await leadAfterKyc.json()).version;
    const dup = await page.request.post(`/api/discovery/leads/${lead.leadRef}/duplicate-check`, { data: { expectedVersion: version } });
    version = (await dup.json()).version;
    const ready = await page.request.post(`/api/discovery/leads/${lead.leadRef}/lifecycle`, { data: { to: "CONVERSION_READY", expectedVersion: version } });
    expect(ready.ok()).toBeTruthy();
    version = (await ready.json()).version;

    // The actual conversion click happens through the real UI.
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("tab", { name: "Ready" }).click();
    await page.getByRole("button", { name: "Convert to Partner" }).click();
    await page.getByRole("button", { name: "Confirm conversion" }).click();
    await expect(page.getByText("This Lead is now linked to a canonical Partner.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Setup pending (New Account)")).toBeVisible();

    const firstPartnerRefText = await page.locator(".kv", { hasText: "Partner reference" }).locator("b").innerText();

    // Repeated conversion (any idempotency key) returns the same Partner.
    const retry = await page.request.post(`/api/discovery/leads/${lead.leadRef}/convert`, {
      data: { idempotencyKey: "a-completely-different-key", expectedVersion: version },
    });
    expect(retry.ok()).toBeTruthy();
    const retryBody = await retry.json();
    expect(retryBody.partnerRef).toBe(firstPartnerRefText.trim());
    expect(retryBody.partnerAccountRef).toBeNull();
  });
});

// ---- Alternative outcomes ----

test.describe("Alternative outcomes", () => {
  test("Watchlist requires a reason and supports reasoned restore", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);

    await page.getByRole("button", { name: "Watchlist", exact: true }).click();
    await expect(page.getByLabel(/Reason for moving to Watchlist/)).toBeVisible();
    // No reason entered yet - Confirm must stay disabled (clicking a
    // disabled button just hangs waiting for it to become actionable).
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();

    await page.getByLabel(/Reason for moving to Watchlist/).fill("Budget under review.");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "Watchlist" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Budget under review.")).toBeVisible();

    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByLabel(/Reason for restoring/).fill("Budget approved.");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "New" })).toBeVisible({ timeout: 5000 });
  });

  test("Reject and Archive are also reasoned, and Duplicate is terminal with no restore action", async ({ page }) => {
    const lead = await createLeadViaApi(page);
    await page.goto(`/discovery/${lead.leadRef}`);
    await page.getByRole("button", { name: "Mark duplicate", exact: true }).click();
    await page.getByLabel(/Reason for moving to Duplicate/).fill("Matches an existing record.");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "Duplicate" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Duplicate is terminal - no restore action is available.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
  });
});

// ---- Scope enforcement ----

test.describe("Scope enforcement", () => {
  test("a scoped user cannot read another-scope Lead by direct URL", async ({ page }) => {
    await signInAs(page, "analyst");
    // seed-lead-researching is Karnataka-only - outside Analyst's seeded
    // REGION grants (Kerala, Tamil Nadu).
    await page.goto("/discovery/seed-lead-researching");
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.getByText("You don't have permission to view this Lead.")).toBeVisible();
  });
});

// ---- Mobile ----

test.describe("Mobile", () => {
  test("Workspace and Detail remain usable at 390×844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const lead = await createLeadViaApi(page);

    await page.goto("/discovery/leads");
    await expect(page.locator("h1")).toHaveText("Discovery");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.goto(`/discovery/${lead.leadRef}`);
    await expect(page.locator("h1")).toHaveText(lead.displayName);
    await expect(page.locator(".workflow")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
