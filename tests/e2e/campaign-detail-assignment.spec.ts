import { test, expect, type Locator, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 12C.1 - Campaign Detail's real downstream summary and the contextual
// "Create Assignment" flow, end to end. Runs in the default `chromium`
// project, pre-authenticated as admin@creatorops.com (Super Admin, GLOBAL
// scope) via the shared storageState - fixtures are created with the
// trusted APIs BEFORE any test signs in as another identity (signInAs
// replaces the page's own session).
//
// Every test creates its OWN unique Campaign + Partner: emulator state
// persists across specs in a run and the (campaign, partner) pair is a
// permanent one-Assignment claim, so nothing here reuses a shared pair.
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

type CampaignApi = { campaignRef: string; version: number; name: string; status: string };

async function createCampaignViaApi(page: Page, options: { state: "DRAFT" | "PLANNED" | "ACTIVE" | "PAUSED"; regionIds?: string[]; platforms?: string[] }): Promise<CampaignApi> {
  const created = await page.request.post("/api/campaigns", {
    data: {
      name: uniqueName("Detail Assignment E2E"),
      objective: "Step 12C.1 Campaign Detail create-assignment E2E coverage.",
      platforms: options.platforms ?? ["instagram", "youtube"],
      startDate: "2026-01-01",
      endDate: "2026-12-01",
      regionIds: options.regionIds ?? ["Kerala"],
      defaultReviewPolicy: "REVIEW_REQUIRED",
    },
  });
  expect(created.ok()).toBeTruthy();
  const campaign = (await created.json()) as CampaignApi;
  let version = campaign.version;
  const steps: string[] = options.state === "DRAFT" ? [] : options.state === "PLANNED" ? ["PLANNED"] : options.state === "ACTIVE" ? ["PLANNED", "ACTIVE"] : ["PLANNED", "ACTIVE", "PAUSED"];
  for (const to of steps) {
    const response = await page.request.post(`/api/campaigns/${campaign.campaignRef}/lifecycle`, { data: { to, expectedVersion: version } });
    expect(response.ok()).toBeTruthy();
    version = ((await response.json()) as { version: number }).version;
  }
  return { ...campaign, version, status: options.state };
}

type PartnerFixture = { partnerRef: string; displayName: string };

async function createPartnerViaApi(page: Page, accounts: Array<{ platform: string; handle: string; displayName: string }>, regionIds = ["Kerala"]): Promise<PartnerFixture> {
  const displayName = uniqueName("E2E Detail Partner");
  const partner = await page.request.post("/api/partners", { data: { displayName, regionIds } });
  expect(partner.ok()).toBeTruthy();
  const { partnerRef } = (await partner.json()) as { partnerRef: string };
  for (const account of accounts) {
    const created = await page.request.post(`/api/partners/${partnerRef}/accounts`, { data: { platform: account.platform, handle: `${account.handle}-${Date.now()}-${Math.floor(Math.random() * 100000)}`, displayName: account.displayName } });
    expect(created.ok()).toBeTruthy();
  }
  return { partnerRef, displayName };
}

async function bodyOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number; docScrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth, docScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

function assignmentsCard(page: Page): Locator {
  return page.locator(".statecard").filter({ has: page.getByRole("heading", { name: "Assignments", exact: true }) });
}
function contentCard(page: Page): Locator {
  return page.locator(".statecard").filter({ has: page.getByRole("heading", { name: "Content", exact: true }) });
}
function analyticsCard(page: Page): Locator {
  return page.locator(".statecard").filter({ has: page.getByRole("heading", { name: "Analytics", exact: true }) });
}

// A server-rendered button can be clicked before React has attached its
// handler (cold dev server) - wait until the element carries React's own
// fiber marker, i.e. it is genuinely interactive.
async function waitUntilHydrated(target: Locator) {
  await target.waitFor({ state: "visible" });
  await expect.poll(async () => target.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactFiber") || key.startsWith("__reactProps")))).toBe(true);
}

async function openCreateDialog(page: Page): Promise<Locator> {
  const trigger = assignmentsCard(page).getByRole("button", { name: "Create Assignment" });
  await waitUntilHydrated(trigger);
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Create Assignment" })).toBeVisible();
  return dialog;
}

async function choosePartner(dialog: Locator, partner: PartnerFixture) {
  await dialog.getByRole("searchbox").fill(partner.displayName);
  await dialog.getByRole("button", { name: new RegExp(partner.displayName) }).click();
}

test.describe("Downstream summary on Campaign Detail", () => {
  test("shows real Assignments / Content / Analytics summaries with deep links - never a placeholder or fixture value", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    await expect(page.getByRole("heading", { name: "Downstream availability" })).toBeVisible();
    await expect(page.locator(".statecard")).toHaveCount(3);
    await expect(page.getByText("Not yet built")).toHaveCount(0);

    // Same three cards, same order as before.
    const titles = await page.locator(".statecard h3").allTextContents();
    expect(titles).toEqual(["Assignments", "Content", "Analytics"]);

    const assignments = assignmentsCard(page);
    await expect(assignments.getByText("0 Assignments")).toBeVisible();
    await expect(assignments.getByText("0 Partners")).toBeVisible();
    await expect(assignments.getByText("0 draft · 0 issued")).toBeVisible();
    await expect(assignments.getByRole("link", { name: "Open Assignments" })).toHaveAttribute("href", "/assignments");

    const content = contentCard(page);
    for (const row of ["Approved", "Awaiting review", "Changes requested"]) await expect(content.locator(".kv").filter({ hasText: row })).toContainText("0");
    await expect(content.getByRole("link", { name: "Open Content" })).toHaveAttribute("href", "/content");

    const analytics = analyticsCard(page);
    await expect(analytics.getByText("No Content records yet")).toBeVisible();
    // Unfiltered deep link - the Explorer honors no Campaign query param, so none is invented.
    await expect(analytics.getByRole("link", { name: "Open Analytics Explorer" })).toHaveAttribute("href", "/analytics/explorer");

    // No Finance/Agreement/Payable text anywhere inside the panel.
    const panel = page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Downstream availability" }) });
    await expect(panel.getByText(/Agreement|Payable|Invoice|Payment|Finance/i)).toHaveCount(0);
  });
});

test.describe("Create Assignment - visibility", () => {
  test("Manager sees Create Assignment on PLANNED and ACTIVE Campaigns, but not on DRAFT or PAUSED ones", async ({ page }) => {
    const planned = await createCampaignViaApi(page, { state: "PLANNED" });
    const active = await createCampaignViaApi(page, { state: "ACTIVE" });
    const draft = await createCampaignViaApi(page, { state: "DRAFT" });
    const paused = await createCampaignViaApi(page, { state: "PAUSED" });

    await signInAs(page, "manager");
    for (const [campaign, shown] of [
      [planned, true],
      [active, true],
      [draft, false],
      [paused, false],
    ] as const) {
      await page.goto(`/campaigns/${campaign.campaignRef}`);
      await expect(assignmentsCard(page).getByRole("link", { name: "Open Assignments" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create Assignment" })).toHaveCount(shown ? 1 : 0);
    }
  });

  test("the action appears after a lifecycle change without a reload (server-decided, not client-derived)", async ({ page }) => {
    const draft = await createCampaignViaApi(page, { state: "DRAFT" });
    await page.goto(`/campaigns/${draft.campaignRef}`);
    await expect(assignmentsCard(page).getByRole("link", { name: "Open Assignments" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Assignment" })).toHaveCount(0);

    const move = page.getByRole("button", { name: "Move to Planned" });
    await waitUntilHydrated(move);
    await move.click();
    await expect(page.locator(".pill", { hasText: "Planned" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Create Assignment" })).toBeVisible({ timeout: 5000 });
  });

  test("Viewer and Analyst see the Campaign but no Create Assignment action, and a truthful no-access message instead of zeros", async ({ page }) => {
    const active = await createCampaignViaApi(page, { state: "ACTIVE" });
    for (const role of ["viewer", "analyst"]) {
      await signInAs(page, role);
      await page.goto(`/campaigns/${active.campaignRef}`);
      await expect(page.getByRole("heading", { name: "Downstream availability" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create Assignment" })).toHaveCount(0);
      await expect(page.getByText("You don't have access to Assignments.")).toBeVisible();
      await expect(page.getByText("0 Assignments")).toHaveCount(0);
    }
  });

  test("a cross-scope Manager cannot open the Campaign at all - no downstream summary and no create action", async ({ page }) => {
    const outside = await createCampaignViaApi(page, { state: "ACTIVE", regionIds: ["Uttar Pradesh"] });
    await signInAs(page, "manager");
    await page.goto(`/campaigns/${outside.campaignRef}`);
    await expect(page.getByText("You don't have permission to view this Campaign.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Assignment" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Downstream availability" })).toHaveCount(0);

    // The trusted routes independently deny the same actor.
    expect((await page.request.get(`/api/campaigns/${outside.campaignRef}/downstream`)).status()).toBe(403);
    expect((await page.request.get(`/api/campaigns/${outside.campaignRef}/assignment-options`)).status()).toBe(403);
  });
});

test.describe("Create Assignment - flow", () => {
  test("Manager creates a Draft Assignment from Campaign Detail, opens it, and the summary updates - with no issue/token/WhatsApp/Content side effect", async ({ page, context }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
    const partner = await createPartnerViaApi(page, [
      { platform: "instagram", handle: "e2emain", displayName: "E2E Main" },
      { platform: "Instagram", handle: "e2ereels", displayName: "E2E Reels" },
      { platform: "tiktok", handle: "e2eother", displayName: "E2E Other" },
    ]);

    await signInAs(page, "manager");

    // Observe everything that could be a side effect.
    const posts: string[] = [];
    let popups = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/")) posts.push(`${request.method()} ${new URL(request.url()).pathname}`);
      if (/wa\.me|whatsapp/i.test(request.url())) posts.push(`WHATSAPP ${request.url()}`);
    });
    context.on("page", () => {
      popups += 1;
    });
    await page.addInitScript(() => {
      (window as unknown as { __opened: unknown[] }).__opened = [];
      window.open = ((...args: unknown[]) => {
        (window as unknown as { __opened: unknown[] }).__opened.push(args);
        return null;
      }) as typeof window.open;
    });

    await page.goto(`/campaigns/${campaign.campaignRef}`);
    await expect(assignmentsCard(page).getByText("0 Assignments")).toBeVisible();

    const dialog = await openCreateDialog(page);
    // Safe Campaign context, fixed - no selector, no raw ids, no forbidden concepts.
    await expect(dialog.getByText(campaign.name)).toBeVisible();
    await expect(dialog.getByText("Instagram, Youtube")).toBeVisible();
    await expect(dialog.locator(".kv").filter({ hasText: "Regions" })).toContainText("Kerala");
    await expect(dialog.getByText("Step 12C.1 Campaign Detail create-assignment E2E coverage.")).toBeVisible();
    await expect(dialog.getByText(/REVIEW_REQUIRED|NO_PREPOST_REVIEW|review policy|Agreement|Payable|Finance|Target Audience|Owner/i)).toHaveCount(0);
    await expect(dialog.getByRole("combobox")).toHaveCount(0); // no Campaign (or any) selector

    // Create is disabled until a Partner AND an account are chosen.
    const create = dialog.getByRole("button", { name: "Create Assignment" });
    await expect(create).toBeDisabled();

    await choosePartner(dialog, partner);
    await expect(dialog.getByText(partner.displayName)).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Change Partner ${partner.displayName}` })).toBeVisible();

    // Accounts: two compatible Instagram accounts (both selectable), one TikTok account disabled with its reason.
    const reels = dialog.getByRole("checkbox", { name: /E2E Reels/ });
    const main = dialog.getByRole("checkbox", { name: /E2E Main/ });
    const other = dialog.getByRole("checkbox", { name: /E2E Other/ });
    await expect(main).toBeEnabled();
    await expect(reels).toBeEnabled();
    await expect(other).toBeDisabled();
    await expect(dialog.getByText("Platform not part of this Campaign")).toBeVisible();
    await expect(create).toBeDisabled(); // two candidates - nothing pre-selected
    await main.check();
    await reels.check();
    await expect(create).toBeEnabled();

    // The supported fields.
    await dialog.getByLabel("Partner-specific instructions").fill("Post two reels featuring the launch.");
    await dialog.getByLabel("Content requirement summary").fill("Two reels, 30 seconds each.");
    await dialog.getByLabel("Required count").fill("2");
    await dialog.getByLabel("Format(s)").fill("Reel, Story");
    await dialog.getByLabel("Due date").fill("2026-11-15");
    await dialog.getByLabel("Language").fill("Malayalam");
    await dialog.getByLabel("Hashtags").fill("#Launch, sale");
    await dialog.getByRole("button", { name: "Add resource link" }).click();
    await dialog.getByLabel("Link 1 label").fill("Brand guide");
    await dialog.getByLabel("Link 1 URL").fill("https://example.com/brand-guide.pdf");
    // shareExternally defaults OFF.
    await expect(dialog.getByRole("checkbox", { name: /Share this link/ })).not.toBeChecked();

    await create.click();
    const success = dialog.getByRole("status").filter({ hasText: "Assignment created as Draft — it has not been issued." });
    await expect(success).toBeVisible({ timeout: 10_000 });

    // Nothing opened a window/tab (no WhatsApp) while creating.
    expect(await page.evaluate(() => (window as unknown as { __opened?: unknown[] }).__opened?.length ?? 0)).toBe(0);

    await dialog.getByRole("link", { name: "Open Assignment" }).click();
    await expect(page).toHaveURL(/\/assignments\/[^/]+$/);
    await expect(page.locator(".pill", { hasText: "Draft" }).first()).toBeVisible();
    const assignmentRef = new URL(page.url()).pathname.split("/").pop()!;

    // What was actually stored.
    const stored = await (await page.request.get(`/api/assignments/${assignmentRef}`)).json();
    expect(stored.status).toBe("DRAFT");
    expect(stored.brief.platforms).toEqual(["instagram"]); // distinct, normalized
    expect(stored.partnerAccountRefs).toHaveLength(2);
    expect(stored.brief).toMatchObject({ instructions: "Post two reels featuring the launch.", requiredCount: 2, formats: ["Reel", "Story"], language: "Malayalam", hashtags: ["Launch", "sale"], dueAt: "2026-11-15" });
    expect(stored.brief.resourceLinks).toEqual([{ label: "Brand guide", url: "https://example.com/brand-guide.pdf", shareExternally: false }]);

    // No Content thread, no submission session/token.
    const threads = await (await page.request.get(`/api/content?assignmentRef=${assignmentRef}&limit=5`)).json();
    expect(threads.content).toEqual([]);
    const session = await (await page.request.get(`/api/assignments/${assignmentRef}/submission-sessions?recipientType=PARTNER`)).json();
    expect(session.session).toBeNull();

    // Only ONE mutating request was ever made: the Assignment create itself.
    expect(posts).toEqual(["POST /api/assignments"]);
    expect(popups).toBe(0);

    // Back on Campaign Detail the summary reflects the new Draft.
    await page.goto(`/campaigns/${campaign.campaignRef}`);
    const assignments = assignmentsCard(page);
    await expect(assignments.getByText("1 Assignment", { exact: true })).toBeVisible();
    await expect(assignments.getByText("1 Partner", { exact: true })).toBeVisible();
    await expect(assignments.getByText("1 draft · 0 issued")).toBeVisible();
    await expect(page.locator(".pill", { hasText: "Active" }).first()).toBeVisible(); // Campaign lifecycle untouched
  });

  test("closing the success dialog refreshes the Campaign Detail counts in place", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "PLANNED" });
    const partner = await createPartnerViaApi(page, [{ platform: "instagram", handle: "e2eone", displayName: "E2E One" }]);
    await signInAs(page, "manager");
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    const dialog = await openCreateDialog(page);
    await choosePartner(dialog, partner);
    // Exactly one compatible account - pre-selected as a convenience.
    await expect(dialog.getByRole("checkbox", { name: /E2E One/ })).toBeChecked();
    await dialog.getByRole("button", { name: "Create Assignment" }).click();
    await expect(dialog.getByText("Assignment created as Draft — it has not been issued.")).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect(assignmentsCard(page).getByText("1 Assignment", { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(assignmentsCard(page).getByText("1 draft · 0 issued")).toBeVisible();
    // Focus returns to the trigger.
    await expect(assignmentsCard(page).getByRole("button", { name: "Create Assignment" })).toBeFocused();
  });

  test("an existing (Campaign, Partner) Assignment is shown as a safe conflict with an Open link - never a duplicate", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
    const partner = await createPartnerViaApi(page, [{ platform: "instagram", handle: "e2edup", displayName: "E2E Dup" }]);
    await signInAs(page, "manager");

    const first = await page.request.post("/api/assignments", { data: { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } } });
    expect(first.status()).toBe(201);
    expect(first.headers()["x-assignment-outcome"]).toBe("created");
    const firstBody = (await first.json()) as { assignmentRef: string };
    // A repeat via the API is the idempotent existing outcome: 200 + header, same Assignment.
    const again = await page.request.post("/api/assignments", { data: { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } } });
    expect(again.status()).toBe(200);
    expect(again.headers()["x-assignment-outcome"]).toBe("existing");
    expect(((await again.json()) as { assignmentRef: string }).assignmentRef).toBe(firstBody.assignmentRef);

    await page.goto(`/campaigns/${campaign.campaignRef}`);
    const dialog = await openCreateDialog(page);
    await choosePartner(dialog, partner);
    await expect(dialog.getByText("An Assignment already exists for this Partner and Campaign.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create Assignment" })).toBeDisabled();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0); // the form is not offered at all
    const open = dialog.getByRole("link", { name: "Open existing Assignment" });
    await expect(open).toHaveAttribute("href", `/assignments/${firstBody.assignmentRef}`);
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/assignments/${firstBody.assignmentRef}$`));

    const list = await (await page.request.get(`/api/assignments?campaignRef=${campaign.campaignRef}&limit=20`)).json();
    expect(list.assignments).toHaveLength(1);
  });

  test("a create that loses a race lands in the same safe existing-Assignment state, never a duplicate or a raw error", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
    const partner = await createPartnerViaApi(page, [{ platform: "instagram", handle: "e2erace", displayName: "E2E Race" }]);
    await signInAs(page, "manager");
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    const dialog = await openCreateDialog(page);
    await choosePartner(dialog, partner);
    await expect(dialog.getByRole("checkbox", { name: /E2E Race/ })).toBeChecked();

    // Someone else creates the pair after the dialog already checked it.
    const raced = await page.request.post("/api/assignments", { data: { campaignRef: campaign.campaignRef, partnerRef: partner.partnerRef, brief: { platforms: ["instagram"] } } });
    expect(raced.status()).toBe(201);

    await dialog.getByRole("button", { name: "Create Assignment" }).click();
    await expect(dialog.getByText("An Assignment already exists for this Partner and Campaign.")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("link", { name: "Open existing Assignment" })).toBeVisible();
    await expect(dialog.getByText("Assignment created as Draft")).toHaveCount(0);
    await expect(dialog.locator('[role="alert"]')).toHaveCount(0);

    const list = await (await page.request.get(`/api/assignments?campaignRef=${campaign.campaignRef}&limit=20`)).json();
    expect(list.assignments).toHaveLength(1);
  });

  test("a Partner with no compatible Partner Account blocks creation truthfully and links to the Partner record", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE", platforms: ["instagram"] });
    const partner = await createPartnerViaApi(page, [{ platform: "tiktok", handle: "e2etiktok", displayName: "E2E TikTok Only" }]);
    await signInAs(page, "manager");
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    const dialog = await openCreateDialog(page);
    await choosePartner(dialog, partner);
    await expect(dialog.getByText("None of this Partner's accounts can be used", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /E2E TikTok Only/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Create Assignment" })).toBeDisabled();
    await expect(dialog.getByRole("link", { name: "Open Partner record" })).toHaveAttribute("href", `/partners/${partner.partnerRef}`);
    await expect(dialog.getByLabel("Partner-specific instructions")).toHaveCount(0);
  });

  test("Partner search is bounded and keyboard-operable (ArrowDown into the results, Enter selects)", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
    const partner = await createPartnerViaApi(page, [{ platform: "instagram", handle: "e2ekey", displayName: "E2E Key" }]);
    await signInAs(page, "manager");
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    const dialog = await openCreateDialog(page);
    const search = dialog.getByRole("searchbox");
    await search.fill(partner.displayName);
    const results = dialog.getByRole("group", { name: "Partner results" }).getByRole("button");
    await expect(results).toHaveCount(1);
    expect(await results.count()).toBeLessThanOrEqual(10);

    await search.press("ArrowDown");
    await expect(results.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: `Change Partner ${partner.displayName}` })).toBeVisible();
    // Change returns to the search.
    await dialog.getByRole("button", { name: `Change Partner ${partner.displayName}` }).click();
    await expect(dialog.getByRole("searchbox")).toBeVisible();

    // The unfiltered default list is capped at 10 server-side.
    await dialog.getByRole("searchbox").fill("");
    await expect(dialog.getByRole("group", { name: "Partner results" }).getByRole("button").first()).toBeVisible();
    expect(await dialog.getByRole("group", { name: "Partner results" }).getByRole("button").count()).toBeLessThanOrEqual(10);
  });

  test("Escape closes the dialog and focus returns to the Create Assignment trigger; the dialog traps focus", async ({ page }) => {
    const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
    await signInAs(page, "manager");
    await page.goto(`/campaigns/${campaign.campaignRef}`);

    const trigger = assignmentsCard(page).getByRole("button", { name: "Create Assignment" });
    await waitUntilHydrated(trigger);
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Focus starts inside the modal dialog and never lands on any page
    // element outside it while tabbing (past the last control the browser
    // may hand focus to its own chrome, i.e. document.body - never to the
    // inert page behind the modal).
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog"))).toBe(true);
    }
    // Re-focus inside the dialog for the Escape step regardless of where the loop ended.
    await dialog.getByRole("button", { name: "Close dialog" }).focus();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("Create Assignment - responsive", () => {
  for (const width of [1200, 1050, 760, 390, 375]) {
    test(`no horizontal page overflow at ${width}px with the dialog closed and open (partner selected)`, async ({ page }) => {
      const campaign = await createCampaignViaApi(page, { state: "ACTIVE" });
      const partner = await createPartnerViaApi(page, [
        { platform: "instagram", handle: "e2eresp", displayName: "E2E Responsive" },
        { platform: "instagram", handle: "e2eresp2", displayName: "E2E Responsive Two" },
      ]);
      await signInAs(page, "manager");
      await page.setViewportSize({ width, height: width < 700 ? 800 : 900 });
      await page.goto(`/campaigns/${campaign.campaignRef}`);
      await expect(assignmentsCard(page).getByRole("link", { name: "Open Assignments" })).toBeVisible();

      const closed = await bodyOverflow(page);
      expect(closed.scrollWidth, `closed at ${width}`).toBeLessThanOrEqual(closed.clientWidth + 1);
      expect(closed.docScrollWidth, `closed (documentElement) at ${width}`).toBeLessThanOrEqual(closed.innerWidth + 1);

      const dialog = await openCreateDialog(page);
      await choosePartner(dialog, partner);
      await dialog.getByRole("checkbox", { name: /E2E Responsive Two/ }).check();
      await dialog.getByRole("button", { name: "Add resource link" }).click();
      await expect(dialog.getByLabel("Partner-specific instructions")).toBeVisible();

      const open = await bodyOverflow(page);
      expect(open.scrollWidth, `open at ${width}`).toBeLessThanOrEqual(open.clientWidth + 1);
      expect(open.docScrollWidth, `open (documentElement) at ${width}`).toBeLessThanOrEqual(open.innerWidth + 1);
      // The dialog itself fits the viewport.
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      // Create and Cancel remain reachable.
      await dialog.getByRole("button", { name: "Create Assignment" }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "Create Assignment" })).toBeVisible();
    });
  }
});
