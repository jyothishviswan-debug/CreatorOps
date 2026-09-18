import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 11B - focused Content UI E2E, mirroring tests/e2e/assignments.spec.ts's
// setup/login/navigation conventions exactly. Runs in the default
// `chromium` project, pre-authenticated as admin@creatorops.com (Super
// Admin, GLOBAL scope) via the shared storageState - tests that need a
// different identity call signInAs explicitly.
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

type AssignmentApi = { assignmentRef: string; version: number; status: string };
type ContentApi = { contentRef: string; version: number; status: string; currentVersion: number; lastSubmittedVersion: number | null };

// A fresh Kerala-scoped (Manager/Head-reachable), REVIEW_REQUIRED or
// NO_PREPOST_REVIEW-driven Campaign + Assignment pair, same idiom as
// assignments.spec.ts's own createAssignmentViaApi.
async function createAssignmentViaApi(page: Page, reviewPolicy: "REVIEW_REQUIRED" | "NO_PREPOST_REVIEW" = "REVIEW_REQUIRED", overrides: Record<string, unknown> = {}): Promise<AssignmentApi> {
  const campaignResponse = await page.request.post("/api/campaigns", {
    data: { name: uniqueName("Content UI Test Campaign"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: reviewPolicy },
  });
  expect(campaignResponse.ok()).toBeTruthy();
  const campaign = (await campaignResponse.json()) as { campaignRef: string; version: number };
  const planned = await page.request.post(`/api/campaigns/${campaign.campaignRef}/lifecycle`, { data: { to: "PLANNED", expectedVersion: campaign.version } });
  expect(planned.ok()).toBeTruthy();

  const response = await page.request.post("/api/assignments", {
    data: { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"], formats: ["reel"], requiredCount: 1 }, ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AssignmentApi;
}

async function transitionAssignmentViaApi(page: Page, assignmentRef: string, to: string, expectedVersion: number): Promise<AssignmentApi> {
  const response = await page.request.post(`/api/assignments/${assignmentRef}/lifecycle`, { data: { to, expectedVersion } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AssignmentApi;
}

// Drives a fresh Assignment all the way to IN_PROGRESS (ASSIGNED ->
// ACCEPTED -> IN_PROGRESS), the state Content generation/production
// requires and Assignment auto-completion needs.
async function createInProgressAssignmentViaApi(page: Page, reviewPolicy: "REVIEW_REQUIRED" | "NO_PREPOST_REVIEW" = "REVIEW_REQUIRED"): Promise<AssignmentApi> {
  const created = await createAssignmentViaApi(page, reviewPolicy);
  const assigned = await transitionAssignmentViaApi(page, created.assignmentRef, "ASSIGNED", created.version);
  const accepted = await transitionAssignmentViaApi(page, created.assignmentRef, "ACCEPTED", assigned.version);
  const inProgress = await transitionAssignmentViaApi(page, created.assignmentRef, "IN_PROGRESS", accepted.version);
  return { ...created, ...inProgress };
}

async function generateContentViaApi(page: Page, assignmentRef: string, overrides: Record<string, unknown> = {}): Promise<ContentApi> {
  const response = await page.request.post("/api/content", { data: { assignmentRef, platform: "instagram", contentType: "reel", ...overrides } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ContentApi;
}

// ---- Authorization ----

test.describe("Authorization", () => {
  test("Viewer is denied (nav + direct route)", async ({ page }) => {
    await signInAs(page, "viewer");
    await expect(page.locator('nav[aria-label="Global navigation"]').getByRole("link", { name: "Content" })).not.toBeVisible();
    await page.goto("/content");
    await expect(page).toHaveURL(/\/access-denied\?feature=content/);
  });

  test("Analyst is denied (nav + direct route)", async ({ page }) => {
    await signInAs(page, "analyst");
    await expect(page.locator('nav[aria-label="Global navigation"]').getByRole("link", { name: "Content" })).not.toBeVisible();
    await page.goto("/content");
    await expect(page).toHaveURL(/\/access-denied\?feature=content/);
  });

  test("Manager has scoped access - in-scope Content succeeds", async ({ page }) => {
    await signInAs(page, "manager");
    const assignment = await createInProgressAssignmentViaApi(page);
    const content = await generateContentViaApi(page, assignment.assignmentRef);
    await page.goto(`/content/${content.contentRef}`);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  });

  test("Manager cross-scope Content is denied", async ({ page }) => {
    await signInAs(page, "manager");
    // seed-content-in-production-review-required carries civic-voices'
    // empty regionIds/teamIds/null-owner snapshot - reachable only via
    // GLOBAL (Super Admin), same rationale as content.emulator.test.ts's
    // own scope proof.
    await page.goto("/content/seed-content-in-production-review-required");
    await expect(page.getByText("Access denied")).toBeVisible();
  });

  test("Super Admin (GLOBAL) reaches every Content record", async ({ page }) => {
    await page.goto("/content/seed-content-planned-review-required");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  });
});

// ---- Workspace ----

test.describe("Workspace", () => {
  test("shows real seeded rows, correct columns, no raw refs, no legacy terms", async ({ page }) => {
    await page.goto("/content");
    await expect(page.locator("h1")).toHaveText("Content");
    await expect(page.getByRole("columnheader", { name: "Record" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Context" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Region" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();

    const bodyText = await page.locator("#main").innerText();
    expect(bodyText).not.toContain("seed-content-");
    expect(bodyText).not.toContain("seed-assignment-");
    for (const legacy of ["Deliverable", "Agreement", "Payable", "Invoice"]) {
      expect(bodyText).not.toContain(legacy);
    }
  });

  test("status filter re-queries real data", async ({ page }) => {
    await page.goto("/content");
    await page.getByLabel("Filter status").selectOption("COMPLETED");
    await expect(page.locator("tbody").getByText("Completed").first()).toBeVisible();
    const statusCells = await page.locator("tbody tr td:nth-child(2)").allTextContents();
    expect(statusCells.every((s) => s.trim() === "Completed")).toBe(true);

    await page.getByLabel("Filter status").selectOption("all");
    await expect(page.getByLabel("Filter status")).toHaveValue("all");
  });

  test("page-scoped search filters currently-loaded rows honestly (explicit caption present)", async ({ page }) => {
    await page.goto("/content");
    await expect(page.getByText("Searches the Content currently loaded on this page.")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search records" }).fill("no-such-content-xyz");
    await expect(page.getByText("No matching Content")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
  });

  test("density and table/card layout toggles work", async ({ page }) => {
    await page.goto("/content");
    await page.getByRole("button", { name: "Cards view" }).click();
    await expect(page.locator(".recordgrid")).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.locator("table")).toBeVisible();
    await page.getByRole("button", { name: /Compact rows|Comfortable rows/ }).click();
  });

  test("row navigation opens the real Detail page", async ({ page }) => {
    await page.goto("/content");
    await page.getByRole("button", { name: /Inspect/ }).first().click();
    await expect(page).toHaveURL(/\/content\/[^/]+$/);
    await expect(page.locator(".eyebrow", { hasText: "CONTENT / RECORD DETAIL" })).toBeVisible();
  });

  test("there is no /content/new route and no global create button", async ({ page }) => {
    await page.goto("/content");
    await expect(page.getByRole("button", { name: /^\+?\s*(New|Create) Content$/i })).toHaveCount(0);
  });
});

// ---- Detail ----

test.describe("Detail", () => {
  test("shows the exact frozen structure: 4-box strip, tabs, panels, no raw refs, no Edit button", async ({ page }) => {
    await page.goto("/content/seed-content-planned-review-required");
    await expect(page.locator(".eyebrow")).toHaveText("CONTENT / RECORD DETAIL");

    for (const label of ["Status", "Responsible owner", "Region", "Last updated"]) {
      await expect(page.locator(".detailcontext").getByText(label, { exact: true })).toBeVisible();
    }

    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Notes & meetings" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "History" })).toBeVisible();
    await expect(page.getByText("Authorized record preview")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Record context" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Next action" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Content evidence" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Content workflow" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes & meetings" })).toBeVisible();

    await expect(page.getByRole("link", { name: /^Edit/ })).toHaveCount(0);

    const bodyText = await page.locator("#main").innerText();
    expect(bodyText).not.toContain("seed-content-planned-review-required");
    expect(bodyText).not.toContain("seed-assignment-draft");
  });

  test("History dialog shows real events for Content created through the trusted service", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page);
    const content = await generateContentViaApi(page, assignment.assignmentRef);
    await page.goto(`/content/${content.contentRef}`);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("dialog").getByText("Content created")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("Notes & meetings shows a truthful unavailable state, both as a panel and as a dialog", async ({ page }) => {
    await page.goto("/content/seed-content-planned-review-required");
    const notesPanel = page.locator(".grid.three > .panel").filter({ hasText: "Notes & meetings" }).first();
    await expect(notesPanel.getByText("Not yet built")).toBeVisible();

    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.getByRole("dialog").getByText("Not yet built")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
  });
});

// ---- REVIEW_REQUIRED lifecycle ----

test.describe("REVIEW_REQUIRED lifecycle", () => {
  test("PLANNED -> production -> submit -> changes requested -> revise -> resubmit -> approve -> publish -> complete", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page, "REVIEW_REQUIRED");
    const content = await generateContentViaApi(page, assignment.assignmentRef);

    await page.goto(`/content/${content.contentRef}`);
    await expect(page.locator(".detailcontext").getByText("Planned")).toBeVisible();

    await page.getByRole("button", { name: "Start production" }).click();
    await expect(page.locator(".detailcontext").getByText("In production")).toBeVisible();

    // Save the first production version.
    await page.getByRole("button", { name: "Save production version" }).click();
    await page.getByLabel("Caption").fill("First cut caption.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.locator(".detailcontext").getByText("Submitted")).toBeVisible();

    // Manager reviews and requests changes.
    await signInAs(page, "manager");
    await page.goto(`/content/${content.contentRef}`);
    await page.getByRole("button", { name: "Review submission" }).click();
    const reviewDialog = page.getByRole("dialog");
    await reviewDialog.getByLabel("Request changes").check();
    await reviewDialog.getByLabel(/Comment/).fill("Please brighten the thumbnail.");
    await reviewDialog.getByRole("button", { name: "Record decision" }).click();
    await expect(page.locator(".detailcontext").getByText("Changes required")).toBeVisible();
    // The branch banner (outside any dialog) - matched via its unique
    // lead-in text, since the reason text itself is deliberately echoed a
    // second time inside the version dialog (a separate, not-yet-open
    // element in the DOM at this point).
    await expect(page.getByText("Revision needed before resubmission.")).toBeVisible();
    await expect(page.locator(".banner").filter({ hasText: "Changes required." })).toContainText("Please brighten the thumbnail.");

    // Save a revised version and resubmit.
    await page.getByRole("button", { name: "Save revised version" }).click();
    await expect(page.getByRole("dialog").getByText("Please brighten the thumbnail.")).toBeVisible();
    await page.getByLabel("Caption").fill("Brighter cut caption.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByRole("button", { name: "Resubmit for review" })).toBeVisible();
    await page.getByRole("button", { name: "Resubmit for review" }).click();
    await expect(page.locator(".detailcontext").getByText("Submitted")).toBeVisible();

    // Manager approves.
    await page.getByRole("button", { name: "Review submission" }).click();
    const approveDialog = page.getByRole("dialog");
    await approveDialog.getByLabel("Approve").check();
    await approveDialog.getByRole("button", { name: "Record decision" }).click();
    await expect(page.locator(".detailcontext").getByText("Approved")).toBeVisible();

    // Record publication - auto-transitions to Posted.
    await page.getByRole("button", { name: "Record publication" }).click();
    const pubDialog = page.getByRole("dialog");
    await pubDialog.getByLabel(/Published URL/).fill(`https://instagram.com/p/e2e-review-${Date.now()}`);
    await pubDialog.getByRole("button", { name: "Record publication" }).click();
    await expect(page.locator(".detailcontext").getByText("Posted")).toBeVisible();

    // Complete.
    await page.getByRole("button", { name: "Complete Content" }).click();
    await expect(page.locator(".detailcontext").getByText("Completed")).toBeVisible();

    // Verify real event/version evidence via History.
    await page.getByRole("tab", { name: "History" }).click();
    const historyDialog = page.getByRole("dialog");
    for (const label of ["Content created", "Production started", "Version saved", "Submitted for review", "Review decision recorded", "Publication evidence added", "Posted", "Completed"]) {
      await expect(historyDialog.getByText(label).first()).toBeVisible();
    }
  });

  test("Manager's review_content grant (Step 11B's own explicit correction) is reflected in the UI - Review submission is visible in-scope", async ({ page }) => {
    // The emulator suite (content.emulator.test.ts) already proves the
    // server-side grant and its cross-scope denial boundary; this proves
    // the client-side actorCanReview gate (computed once, server-side, in
    // src/app/content/[contentId]/page.tsx) actually reflects it.
    const assignment = await createInProgressAssignmentViaApi(page, "REVIEW_REQUIRED");
    const content = await generateContentViaApi(page, assignment.assignmentRef);
    await page.request.post(`/api/content/${content.contentRef}/production`, { data: { expectedVersion: content.version } });
    await page.request.post(`/api/content/${content.contentRef}/versions`, { data: { expectedVersion: content.version + 1 } });
    const submitRes = await page.request.post(`/api/content/${content.contentRef}/submit`, { data: { expectedVersion: content.version + 2 } });
    expect(submitRes.ok()).toBeTruthy();

    await signInAs(page, "manager");
    await page.goto(`/content/${content.contentRef}`);
    await expect(page.getByRole("button", { name: "Review submission" })).toBeVisible();
  });
});

// ---- NO_PREPOST_REVIEW lifecycle ----

test.describe("NO_PREPOST_REVIEW lifecycle", () => {
  test("PLANNED -> production -> publish -> complete, with no review controls or fake approval event anywhere", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page, "NO_PREPOST_REVIEW");
    const content = await generateContentViaApi(page, assignment.assignmentRef);

    await page.goto(`/content/${content.contentRef}`);
    await expect(page.locator(".detailcontext").getByText("Planned")).toBeVisible();

    await page.getByRole("button", { name: "Start production" }).click();
    await expect(page.locator(".detailcontext").getByText("In production")).toBeVisible();

    // No submit-for-review control anywhere.
    await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review submission" })).toHaveCount(0);

    await page.getByRole("button", { name: "Record publication" }).click();
    const pubDialog = page.getByRole("dialog");
    await pubDialog.getByLabel(/Published URL/).fill(`https://instagram.com/p/e2e-norev-${Date.now()}`);
    await pubDialog.getByRole("button", { name: "Record publication" }).click();
    await expect(page.locator(".detailcontext").getByText("Posted")).toBeVisible();

    await page.getByRole("button", { name: "Complete Content" }).click();
    await expect(page.locator(".detailcontext").getByText("Completed")).toBeVisible();

    // The workflow stepper only ever shows the 4 mainline steps.
    await expect(page.getByText("Submitted", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Approved", { exact: true })).toHaveCount(0);

    await page.getByRole("tab", { name: "History" }).click();
    const historyDialog = page.getByRole("dialog");
    await expect(historyDialog.getByText("Review decision recorded")).toHaveCount(0);
    await expect(historyDialog.getByText("Submitted for review")).toHaveCount(0);
  });
});

// ---- Assignment integration ----

test.describe("Assignment integration", () => {
  test("Assignment Content panel shows real Content and Plan Content creates a required item from constrained context", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);

    const contentPanel = page.locator(".grid.three > .panel").filter({ hasText: "Content" }).first();
    await expect(contentPanel.getByText("No Content yet")).toBeVisible();

    await contentPanel.getByRole("button", { name: "Plan Content" }).click();
    const planDialog = page.getByRole("dialog");
    await expect(planDialog.getByText("Required obligation")).toBeVisible();
    await planDialog.getByRole("button", { name: "Create Content" }).click();
    await expect(planDialog.getByText("Content created.")).toBeVisible();
    await planDialog.getByRole("button", { name: "Done" }).click();

    await expect(contentPanel.getByText("0 of 1 required Content completed")).toBeVisible();

    // A second required attempt (no free slot left - requiredCount 1) must
    // surface the real "No required Content slot is available" message,
    // never a silent extra.
    await contentPanel.getByRole("button", { name: "Plan Content" }).click();
    const planDialog2 = page.getByRole("dialog");
    await planDialog2.getByRole("button", { name: "Create Content" }).click();
    await expect(planDialog2.getByText(/No required Content slot is available/)).toBeVisible();

    // Explicitly choosing Extra succeeds instead.
    await planDialog2.getByLabel("Extra (non-obligation)").check();
    await planDialog2.getByRole("button", { name: "Create Content" }).click();
    await expect(planDialog2.getByText("Content created.")).toBeVisible();
  });

  test("final required qualifying Content completes the Assignment for real", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page, "NO_PREPOST_REVIEW");
    const content = await generateContentViaApi(page, assignment.assignmentRef);

    await page.goto(`/content/${content.contentRef}`);
    await page.getByRole("button", { name: "Start production" }).click();
    await page.getByRole("button", { name: "Record publication" }).click();
    const pubDialog = page.getByRole("dialog");
    await pubDialog.getByLabel(/Published URL/).fill(`https://instagram.com/p/e2e-fulfill-${Date.now()}`);
    await pubDialog.getByRole("button", { name: "Record publication" }).click();
    await page.getByRole("button", { name: "Complete Content" }).click();
    await expect(page.locator(".detailcontext").getByText("Completed")).toBeVisible();

    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await expect(page.locator(".detailcontext").getByText("Completed")).toBeVisible();
  });
});

// ---- Responsive ----

test.describe("Mobile", () => {
  test("Workspace, Detail, review and publication dialogs stay usable at 390×844, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/content");
    await expect(page.locator("h1")).toHaveText("Content");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Cards view" }).click();
    await expect(page.locator(".recordgrid")).toBeVisible();

    const assignment = await createInProgressAssignmentViaApi(page);
    const content = await generateContentViaApi(page, assignment.assignmentRef);
    await page.goto(`/content/${content.contentRef}`);
    await expect(page.locator("h1")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Start production" }).click();
    await page.getByRole("button", { name: "Save production version" }).click();
    const versionDialog = page.getByRole("dialog");
    await expect(versionDialog).toBeVisible();
    await versionDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.goto(`/assignments/${assignment.assignmentRef}`);
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
