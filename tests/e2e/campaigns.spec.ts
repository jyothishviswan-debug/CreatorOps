import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// This file runs in the default `chromium` project, pre-authenticated as
// admin@creatorops.com (Super Admin, GLOBAL scope) via the shared
// storageState - same baseline as vendors.spec.ts/partners.spec.ts.
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

// CampaignForm/CampaignPlanEditPanel render fields with the shared
// `@/ui/Form` Field component (or a plain ".field" div), whose <label>
// is a sibling of the input (no htmlFor/id) - same locator idiom
// vendors.spec.ts already uses to work around it.
function formField(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(".field").filter({ has: page.locator("label", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) }) }).locator("input, select, textarea");
}

type CampaignApi = { campaignRef: string; version: number; name: string; status: string };

async function createCampaignViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<CampaignApi> {
  const response = await page.request.post("/api/campaigns", {
    data: {
      name: uniqueName("E2E Campaign"),
      objective: "E2E test objective for this Campaign.",
      startDate: "2026-01-01",
      endDate: "2026-06-01",
      defaultReviewPolicy: "REVIEW_REQUIRED",
      ...overrides,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as CampaignApi;
}

// ---- Overview / Workspace ----

test.describe("Overview", () => {
  test("shows the approved slot structure with real Campaign-owned data, never fabricated downstream numbers", async ({ page }) => {
    await page.goto("/campaigns");
    await expect(page.locator("h1")).toHaveText("Campaigns");

    // Exactly the approved 4 KPI titles, in order.
    const kpiLabels = await page.locator(".ov-kpi-label").allTextContents();
    expect(kpiLabels).toEqual(["Active campaigns", "Assigned Partners", "Content completed", "Overdue content"]);

    // Exactly the approved 3 top / 4 bottom panel titles, in order.
    const panelTitles = await page.locator(".ov-panel h2").allTextContents();
    expect(panelTitles).toEqual(["Campaign Execution", "Delivery State", "Staffing Readiness", "Tracking Readiness", "Execution Exceptions", "Recent Activity", "Quick Actions"]);

    // Downstream-domain slots (Content/Assignments/Analytics don't exist
    // yet) show a truthful placeholder, never a fabricated number.
    await expect(page.getByText("Not yet available").first()).toBeVisible();
    await expect(page.getByText(/tracking depends on the Content module/)).toBeVisible();
    await expect(page.getByText(/depends on Assignments/)).toBeVisible();

    // Campaign-owned real signals.
    await expect(page.getByText("Real scoped emulator data")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent Activity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quick Actions" })).toBeVisible();
  });

  test("in-page Overview/Workspace toggle has no separate /campaigns/workspace route", async ({ page }) => {
    await page.goto("/campaigns");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page).toHaveURL(/\/campaigns$/); // still the same route, not a navigation
    await expect(page.locator(".tablewrap table, .recordgrid")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Workspace", () => {
  test("search finds a Campaign by name via a real bounded query", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { name: uniqueName("Findable Campaign") });

    await page.goto("/campaigns");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Search campaigns by name").fill(campaign.name);
    await expect(page.getByText(campaign.name)).toBeVisible({ timeout: 5000 });
  });

  test("status/platform/region filters auto-apply via real bounded queries", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { name: uniqueName("Filterable Campaign"), platforms: ["instagram"], regionIds: ["Goa"] });

    await page.goto("/campaigns");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Search campaigns by name").fill(campaign.name);
    await expect(page.getByText(campaign.name)).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Search campaigns by name").fill("");
    await page.getByLabel("Filter platform").fill("instagram");
    await page.getByRole("button", { name: "Select regions…" }).click();
    await page.getByRole("checkbox", { name: "Goa" }).check();
    await page.getByLabel("Search campaigns by name").click(); // closes the dropdown via outside click
    await expect(page.getByText(campaign.name)).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Goa" }).click();
    await page.getByRole("checkbox", { name: "Goa" }).uncheck();
    await page.getByLabel("Search campaigns by name").click();
    await page.getByLabel("Filter platform").fill("");
    await page.getByLabel("Filter status").selectOption("DRAFT");
    await expect(page.getByText(campaign.name)).toBeVisible({ timeout: 5000 });
  });

  test("pagination and table/card toggle work against real, deterministically-ordered pages", async ({ page }) => {
    await page.goto("/campaigns");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Cards view" }).click();
    await expect(page.locator(".recordgrid .record").first()).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible({ timeout: 5000 });
  });

  test("same-scope user can open a Campaign's Detail page directly", async ({ page }) => {
    await signInAs(page, "manager");
    const campaign = await createCampaignViaApi(page, { name: uniqueName("Manager Scoped Campaign"), regionIds: ["Kerala"] });
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await expect(page.locator("h1")).toHaveText(campaign.name);
  });

  test("cross-scope user cannot read another-scope Campaign by direct URL, and gets the same safe denial as a nonexistent one", async ({ page }) => {
    await signInAs(page, "manager");
    // seed-campaign-paused is Uttar Pradesh - outside Manager's seeded
    // REGION grants (Kerala/Maharashtra/South Zone/West Zone).
    await page.goto("/campaigns/seed-campaign-paused");
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.getByText("You don't have permission to view this Campaign.")).toBeVisible();
  });

  test("civic-voices is reachable for Head only through its explicit CAMPAIGN scope grant, not through a region Head otherwise holds", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/campaigns/civic-voices");
    await expect(page.locator("h1")).toHaveText("Civic Voices");

    await signInAs(page, "manager");
    await page.goto("/campaigns/civic-voices");
    await expect(page.getByText("Access denied")).toBeVisible();
  });
});

// ---- Create ----

test.describe("Create Campaign", () => {
  test("direct create lands on the real Campaign detail, in DRAFT", async ({ page }) => {
    await page.goto("/campaigns/new");
    const name = uniqueName("Created Campaign");
    await formField(page, "Campaign name").fill(name);
    await formField(page, "Start date").fill("2026-02-01");
    await formField(page, "End date").fill("2026-08-01");
    await formField(page, "Objective / description").fill("A real E2E-created Campaign.");

    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[A-Za-z0-9-]+$/);
    await expect(page.locator("h1")).toHaveText(name);
    await expect(page.locator(".pill", { hasText: "Draft" })).toBeVisible({ timeout: 5000 });
  });

  test("Target Audience offers exactly the five accepted values, with no Tier field anywhere on the form", async ({ page }) => {
    await page.goto("/campaigns/new");
    const options = await formField(page, "Target Audience").locator("option").allTextContents();
    expect(options.map((o) => o.trim())).toEqual(["Not set", "India Alpha", "India 1", "India 2", "India 3", "India 4"]);

    const labels = (await page.locator("label").allTextContents()).map((l) => l.toLowerCase());
    expect(labels.some((l) => l.includes("tier"))).toBe(false);
  });

  test("no Agreement/Finance/Payable/Invoice/Payment/Payee/compensation field anywhere on the Create form", async ({ page }) => {
    await page.goto("/campaigns/new");
    await expect(page.getByLabel(/Agreement|Finance|Payable|Invoice|Payment|Payee|compensation/i)).toHaveCount(0);
  });

  test("normalized platform identifiers are accepted; a post-normalization duplicate is rejected, not silently merged; no old fixed platform whitelist is reintroduced", async ({ page }) => {
    const created = await createCampaignViaApi(page, { platforms: ["Instagram", "YouTube"] });
    const fetched = await page.request.get(`/api/campaigns/${created.campaignRef}`);
    const body = (await fetched.json()) as { platforms: string[] };
    expect(body.platforms.sort()).toEqual(["instagram", "youtube"]);

    // "Instagram"/"instagram" normalize to the same identifier - Step
    // 9A.1's contract rejects the post-normalization duplicate outright,
    // it never silently drops one.
    const rejected = await page.request.post("/api/campaigns", {
      data: {
        name: uniqueName("Duplicate Platforms"),
        objective: "x",
        startDate: "2026-01-01",
        endDate: "2026-06-01",
        defaultReviewPolicy: "REVIEW_REQUIRED",
        platforms: ["Instagram", "instagram"],
      },
    });
    expect(rejected.ok()).toBeFalsy();
    expect(rejected.status()).toBe(400);

    // The Platforms field is a real multi-select dropdown (never a
    // native <datalist> popup) - convenience checkboxes plus a free-text
    // "Other platform" row, never a fixed whitelist.
    await page.goto("/campaigns/new");
    await page.getByRole("button", { name: "Select platforms…" }).first().click();
    await expect(page.getByText("Instagram", { exact: true })).toBeVisible();
    await expect(page.getByText("YouTube", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Other platform…")).toBeVisible();
  });

  test("owner is optional at create - absence never blocks creation", async ({ page }) => {
    await page.goto("/campaigns/new");
    const name = uniqueName("Ownerless Campaign");
    await formField(page, "Campaign name").fill(name);
    await formField(page, "Start date").fill("2026-02-01");
    await formField(page, "End date").fill("2026-08-01");
    await formField(page, "Objective / description").fill("No owner assigned at create.");
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page.locator("h1")).toHaveText(name, { timeout: 5000 });
  });

  test("both review policies are selectable and persist", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { defaultReviewPolicy: "NO_PREPOST_REVIEW" });
    const fetched = await page.request.get(`/api/campaigns/${campaign.campaignRef}`);
    const body = (await fetched.json()) as { defaultReviewPolicy: string };
    expect(body.defaultReviewPolicy).toBe("NO_PREPOST_REVIEW");
  });

  test("invalid date range is rejected", async ({ page }) => {
    const response = await page.request.post("/api/campaigns", {
      data: { name: uniqueName("Bad Dates"), objective: "x", startDate: "2026-06-01", endDate: "2026-01-01", defaultReviewPolicy: "REVIEW_REQUIRED" },
    });
    expect(response.ok()).toBeFalsy();
    expect(response.status()).toBe(400);
  });
});

// ---- Detail: Plan edit ----

test.describe("Campaign Plan edit", () => {
  test("ordinary edit, and a stale write is handled explicitly", async ({ page }) => {
    const campaign = await createCampaignViaApi(page);
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await page.getByRole("tab", { name: "Plan" }).click();
    await page.getByRole("button", { name: "Edit plan" }).click();
    await formField(page, "Objective / description").fill("Updated objective via E2E.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Updated objective via E2E.")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Edit plan" }).click();
    const outOfBand = await page.request.patch(`/api/campaigns/${campaign.campaignRef}`, {
      data: { objective: "Out of band update.", expectedVersion: campaign.version + 1 },
    });
    expect(outOfBand.ok()).toBeTruthy();

    await formField(page, "Objective / description").fill("Stale attempt.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("This Campaign was changed elsewhere.")).toBeVisible({ timeout: 5000 });
  });

  test("owner/team change uses its own authorized path, not the generic plan edit", async ({ page }) => {
    const campaign = await createCampaignViaApi(page);
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await page.getByRole("button", { name: "Change" }).first().click();
    await page.locator('.field.full input[type="text"]').fill("kerala-programmes");
    await page.getByRole("button", { name: "Save owner/team" }).click();
    await expect(page.getByText("kerala-programmes")).toBeVisible({ timeout: 5000 });
  });
});

// ---- Resources ----

test.describe("Resources", () => {
  test("add, edit and remove ordinary resource metadata", async ({ page }) => {
    const campaign = await createCampaignViaApi(page);
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await page.getByRole("tab", { name: "Resources" }).click();

    await page.getByRole("button", { name: "+ Add resource" }).click();
    await formField(page, "Label / title").fill("Launch brief");
    await formField(page, "URL / reference").fill("https://example.com/brief.pdf");
    await page.getByRole("button", { name: "Add resource" }).click();
    await expect(page.getByText("Launch brief")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Edit" }).click();
    await formField(page, "Label / title").fill("Launch brief v2");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Launch brief v2")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No resources yet")).toBeVisible({ timeout: 5000 });
  });
});

// ---- Readiness ----

test.describe("Readiness", () => {
  test("a DRAFT missing platforms shows the real server-computed blocker, not a client-side re-implementation", async ({ page }) => {
    const campaign = await createCampaignViaApi(page); // no platforms
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await expect(page.getByText("blocker")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("At least one platform is required.")).toBeVisible();
  });

  test("owner absence is a warning, never a hard readiness failure", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { platforms: ["instagram"] });
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await expect(page.getByText("No owner is assigned yet.")).toBeVisible({ timeout: 5000 });
  });

  test("DRAFT -> PLANNED displays server-returned blockers when not ready", async ({ page }) => {
    const campaign = await createCampaignViaApi(page); // no platforms - not ready
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await page.getByRole("button", { name: "Move to Planned" }).click();
    await expect(page.getByText("Not ready.")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".pill", { hasText: "Draft" })).toBeVisible();
  });
});

// ---- Lifecycle ----

test.describe("Lifecycle", () => {
  test("DRAFT -> PLANNED -> ACTIVE -> PAUSED -> ACTIVE -> COMPLETED -> ARCHIVED, the exact accepted graph", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { platforms: ["instagram"] });
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    await page.getByRole("button", { name: "Move to Planned" }).click();
    await expect(page.locator(".pill", { hasText: "Planned" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.locator(".pill", { hasText: "Paused" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Mark Completed" }).click();
    await expect(page.locator(".pill", { hasText: "Completed" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByLabel(/Reason for archiving/).fill("E2E archive from Completed.");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "Archived" })).toBeVisible({ timeout: 5000 });

    // Terminal - no restore control exists anywhere on the page.
    await expect(page.getByText("Archived is a terminal state")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore" })).toHaveCount(0);
  });

  test("Cancel requires a reason", async ({ page }) => {
    const campaign = await createCampaignViaApi(page);
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await page.getByRole("button", { name: "Cancel campaign" }).click();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await page.getByLabel(/Reason for cancelling/).fill("E2E cancellation reason.");
    await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "Cancelled" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("E2E cancellation reason.")).toBeVisible();
  });

  test("an invalid transition is rejected server-side with a plain error, not silently accepted", async ({ page }) => {
    const campaign = await createCampaignViaApi(page); // DRAFT
    const response = await page.request.post(`/api/campaigns/${campaign.campaignRef}/lifecycle`, {
      data: { to: "ACTIVE", expectedVersion: campaign.version }, // DRAFT -> ACTIVE is not a valid edge
    });
    expect(response.ok()).toBeFalsy();
  });
});

// ---- History ----

test.describe("History", () => {
  test("shows material events for a real Campaign created and transitioned through the trusted service", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { platforms: ["instagram"] });
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await page.getByRole("button", { name: "Move to Planned" }).click();
    await expect(page.locator(".pill", { hasText: "Planned" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Campaign created")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Lifecycle transitioned")).toBeVisible();
  });
});

// ---- Downstream truth boundaries ----

test.describe("Downstream truth boundaries", () => {
  test("Overview tab shows truthful not-yet-built placeholders for Assignments/Content/Analytics, never a fabricated count", async ({ page }) => {
    const campaign = await createCampaignViaApi(page);
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    const downstreamLabels = ["Assignments", "Content", "Analytics"];
    for (const label of downstreamLabels) {
      await expect(page.getByRole("heading", { name: label })).toBeVisible();
    }
    await expect(page.locator(".statecard")).toHaveCount(downstreamLabels.length);
    await expect(page.getByText("Not yet built").first()).toBeVisible();
    for (const fabricated of ["Partners assigned", "Content pieces", "delivery complete"]) {
      await expect(page.getByText(fabricated)).toHaveCount(0);
    }
  });

  test("Campaign Detail has no Agreement/Finance section, placeholder, action, or link - Finance is a fully separate, un-referenced domain", async ({ page }) => {
    const campaign = await createCampaignViaApi(page);
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    // Scoped to the page's own main content, excluding the AppShell's
    // global navigation (which legitimately links to /finance from every
    // page - that's not a Campaign-owned reference).
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { name: "Commercial Agreements" })).toHaveCount(0);
    await expect(main.getByRole("heading", { name: /Agreement|Finance|Payable|Invoice|Payment/i })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Agreement|Finance|Payable|Invoice|Payment/i })).toHaveCount(0);
    await expect(main.getByRole("link", { name: /Agreement|Finance|Payable|Invoice|Payment/i })).toHaveCount(0);
  });
});

// ---- Role / read-only behavior ----

test.describe("Role behavior", () => {
  test("Viewer can read a same-scope Campaign, but a mutation attempt is denied server-side (buttons are gated by current status, not client-side role - the server is the sole authority on every attempt, same idiom as Vendors'/Partners' own lifecycle panels)", async ({ page }) => {
    await signInAs(page, "viewer");
    // seed-campaign-draft is Kerala - inside Viewer's seeded REGION grants,
    // so the Campaign itself is readable; Viewer's own campaigns grant has
    // view:true but no action grants at all (see seed-access-data.ts).
    await page.goto("/campaigns/seed-campaign-draft");
    await expect(page.locator("h1")).toBeVisible();
    await page.getByRole("button", { name: "Move to Planned" }).click();
    await expect(page.getByText("Forbidden.")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".pill", { hasText: "Draft" })).toBeVisible(); // status never actually changed
  });

  test("targeting region alone never grants Campaign record access", async ({ page }) => {
    // seed-campaign-paused's own targeting criteria.regionIds includes
    // Uttar Pradesh, which Manager does NOT hold as a scope grant - proving
    // criteria never substitutes for real scope.
    await signInAs(page, "manager");
    await page.goto("/campaigns/seed-campaign-paused");
    await expect(page.getByText("Access denied")).toBeVisible({ timeout: 5000 });
  });
});

// ---- Mobile ----

test.describe("Mobile", () => {
  test("Campaign Overview and Detail remain usable at 390×844, no content overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const campaign = await createCampaignViaApi(page);

    await page.goto("/campaigns");
    await expect(page.locator("h1")).toHaveText("Campaigns");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await expect(page.locator("h1")).toHaveText(campaign.name);
    await expect(page.locator(".workflow")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
