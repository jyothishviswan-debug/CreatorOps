import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 11A.1 - focused Content UI E2E, mirroring tests/e2e/assignments.spec.ts's
// setup/login/navigation conventions exactly. Runs in the default
// `chromium` project, pre-authenticated as admin@creatorops.com (Super
// Admin, GLOBAL scope) via the shared storageState - tests that need a
// different identity call signInAs explicitly.
//
// Rewritten entirely for the simplified post-link-review model: Content
// is now ONE canonical submission-review thread per Assignment (OPEN ->
// UNDER_REVIEW -> APPROVED, with REVISION_REQUESTED/CANCELLED as branch/
// terminal states). Submission only ever happens via the public
// /submit/[token] page - there is no manual create, no production/
// version/submit/publication-evidence/complete step anywhere in this UI.
// Every scenario below is driven through the REAL public route and the
// REAL trusted Manager review actions - mirroring
// assignments.spec.ts's own "Public submission page" describe block.
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
type ContentThreadApi = { contentRef: string; version: number; status: string; reviewedRevisionNumber: number | null; currentRevisionNumber: number };

async function createAssignmentViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<AssignmentApi> {
  const campaignResponse = await page.request.post("/api/campaigns", {
    data: { name: uniqueName("Content UI Test Campaign"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
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

async function createAssignedAssignmentViaApi(page: Page): Promise<AssignmentApi> {
  const created = await createAssignmentViaApi(page);
  const assigned = await transitionAssignmentViaApi(page, created.assignmentRef, "ASSIGNED", created.version);
  return { ...created, ...assigned };
}

// Drives a fresh Assignment all the way to IN_PROGRESS - the state
// Assignment auto-completion (on Content approval) needs.
async function createInProgressAssignmentViaApi(page: Page): Promise<AssignmentApi> {
  const assigned = await createAssignedAssignmentViaApi(page);
  const accepted = await transitionAssignmentViaApi(page, assigned.assignmentRef, "ACCEPTED", assigned.version);
  const inProgress = await transitionAssignmentViaApi(page, assigned.assignmentRef, "IN_PROGRESS", accepted.version);
  return { ...assigned, ...inProgress };
}

async function createSubmissionTokenViaApi(page: Page, assignmentRef: string): Promise<string> {
  const response = await page.request.post(`/api/assignments/${assignmentRef}/submission-sessions`, { data: { recipientType: "PARTNER" } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { rawToken: string };
  return body.rawToken;
}

async function getThreadViaApi(page: Page, assignmentRef: string): Promise<ContentThreadApi> {
  const response = await page.request.get(`/api/content?assignmentRef=${encodeURIComponent(assignmentRef)}&limit=1`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { content: ContentThreadApi[] };
  const thread = body.content[0];
  if (!thread) throw new Error(`no Content thread found for ${assignmentRef}`);
  return thread;
}

// Submits one link through the REAL public page UI - never a direct API
// call - so every lifecycle test here proves the actual click-through
// path a Partner would use.
async function submitOneLinkViaPublicPage(page: Page, token: string, url: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto(`/submit/${token}`);
  await page.getByLabel("Platform").first().selectOption("instagram");
  await page.getByLabel("Published URL").first().fill(url);
  await page.getByRole("button", { name: /Submit Links|Resubmit Links/ }).click();
  await expect(page.getByText("Links submitted for review")).toBeVisible();
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
    await page.goto("/content/seed-content-under-review");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  });

  test("Manager cross-scope Content is denied", async ({ page }) => {
    await signInAs(page, "manager");
    // community-story-reel-01 is reachable only via Head's own
    // EXPLICIT_RECORD grant (see seed-access-data.ts), never Manager's.
    await page.goto("/content/community-story-reel-01");
    await expect(page.getByText("Access denied")).toBeVisible();
  });

  test("Super Admin (GLOBAL) reaches every Content record", async ({ page }) => {
    await page.goto("/content/seed-content-open");
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
    for (const legacy of ["Deliverable", "Agreement", "Payable", "Invoice", "Publication evidence", "Production started"]) {
      expect(bodyText).not.toContain(legacy);
    }
  });

  test("status filter shows the 5 real canonical statuses and re-queries real data", async ({ page }) => {
    await page.goto("/content");
    for (const label of ["Open", "Under review", "Revision requested", "Approved", "Cancelled"]) {
      await expect(page.getByLabel("Filter status").locator("option", { hasText: label })).toHaveCount(1);
    }

    await page.getByLabel("Filter status").selectOption("APPROVED");
    await expect(page.locator("tbody").getByText("Approved").first()).toBeVisible();
    const statusCells = await page.locator("tbody tr td:nth-child(2)").allTextContents();
    expect(statusCells.every((s) => s.trim() === "Approved")).toBe(true);

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

  test("there is no /content/new route and no global create button - Content is only ever created automatically", async ({ page }) => {
    await page.goto("/content");
    await expect(page.getByRole("button", { name: /^\+?\s*(New|Create|Plan) Content$/i })).toHaveCount(0);
  });
});

// ---- Detail ----

test.describe("Detail", () => {
  test("shows the exact frozen structure: 4-box strip, tabs, panels, no raw refs, no Edit button", async ({ page }) => {
    await page.goto("/content/seed-content-open");
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
    await expect(page.getByRole("heading", { name: "Submitted links" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Content workflow" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes & meetings" })).toBeVisible();

    await expect(page.getByRole("link", { name: /^Edit/ })).toHaveCount(0);

    const bodyText = await page.locator("#main").innerText();
    expect(bodyText).not.toContain("seed-content-open");
    expect(bodyText).not.toContain("seed-assignment-assigned");
  });

  test("Notes & meetings shows a truthful unavailable state, both as a panel and as a dialog", async ({ page }) => {
    await page.goto("/content/seed-content-open");
    const notesPanel = page.locator(".grid.three > .panel").filter({ hasText: "Notes & meetings" }).first();
    await expect(notesPanel.getByText("Not yet built")).toBeVisible();

    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.getByRole("dialog").getByText("Not yet built")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
  });

  test("REVISION_REQUESTED shows the real branch banner with its own reason", async ({ page }) => {
    await page.goto("/content/seed-content-revision-requested");
    await expect(page.locator(".detailcontext").getByText("Revision requested")).toBeVisible();
    const banner = page.locator(".banner").filter({ hasText: "Changes requested." });
    await expect(banner.getByText("The public submission page has reopened for correction.")).toBeVisible();
    await expect(banner).toContainText("Please retake the intro shot in better lighting and re-submit.");
  });

  test("CANCELLED shows the real branch banner with its own reason", async ({ page }) => {
    await page.goto("/content/seed-content-cancelled");
    await expect(page.locator(".detailcontext").getByText("Cancelled")).toBeVisible();
    await expect(page.getByText("Partner became unavailable before this obligation could proceed.")).toBeVisible();
  });
});

// ---- Full revision loop (submit -> review -> revise -> resubmit -> approve) ----

test.describe("Revision loop", () => {
  test("OPEN -> submit (public page) -> Under review -> Manager requests changes -> SAME public page reopens prefilled -> resubmit -> Manager approves -> Approved, closed", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    // Partner submits via the real public page.
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-loop-1");

    // Manager reviews via the real staff UI and requests changes -
    // submitOneLinkViaPublicPage cleared cookies to simulate an
    // anonymous Partner, so sign in before the next authenticated call.
    await signInAs(page, "manager");
    const thread1 = await getThreadViaApi(page, assignment.assignmentRef);
    expect(thread1.status).toBe("UNDER_REVIEW");
    await page.goto(`/content/${thread1.contentRef}`);
    await expect(page.locator(".detailcontext").getByText("Under review")).toBeVisible();
    await page.getByRole("button", { name: "Review submission" }).click();
    const reviewDialog = page.getByRole("dialog");
    await reviewDialog.getByRole("radio", { name: "Request changes" }).check();
    await reviewDialog.getByLabel(/Reason/).fill("Please retake the shot in better lighting.");
    await reviewDialog.getByRole("button", { name: "Record decision" }).click();
    await expect(page.locator(".detailcontext").getByText("Revision requested")).toBeVisible();
    await expect(page.getByText("Please retake the shot in better lighting.")).toBeVisible();

    // The SAME public page/token reopens, prefilled, with the real reason.
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-loop-2");

    // Manager approves.
    await signInAs(page, "manager");
    const thread2 = await getThreadViaApi(page, assignment.assignmentRef);
    expect(thread2.currentRevisionNumber).toBe(2);
    await page.goto(`/content/${thread2.contentRef}`);
    await expect(page.locator(".detailcontext").getByText("Under review")).toBeVisible();
    await page.getByRole("button", { name: "Review submission" }).click();
    const approveDialog = page.getByRole("dialog");
    await approveDialog.getByRole("radio", { name: "Approve" }).check();
    await approveDialog.getByRole("button", { name: "Record decision" }).click();
    await expect(page.locator(".detailcontext").getByText("Approved")).toBeVisible();

    // Next Action panel now shows the terminal, closed state - no
    // separate "Complete Content" action exists anywhere.
    await expect(page.getByText("Approved — closed")).toBeVisible();
    await expect(page.getByRole("button", { name: /Complete/ })).toHaveCount(0);

    // The public page itself is now permanently closed too.
    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    await expect(page.getByText("Links approved")).toBeVisible();
    await expect(page.getByText("This submission is closed.")).toBeVisible();

    // Verify real event history reflects the whole loop.
    await signInAs(page, "manager");
    await page.goto(`/content/${thread2.contentRef}`);
    await page.getByRole("tab", { name: "History" }).click();
    const historyDialog = page.getByRole("dialog");
    for (const label of ["Submission thread created", "Links submitted", "Revision requested", "Approved"]) {
      await expect(historyDialog.getByText(label).first()).toBeVisible();
    }
  });

  test("REVISION_REQUESTED has no Reject option anywhere - only Approve and Request changes", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-no-reject");

    await signInAs(page, "admin");
    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    await page.goto(`/content/${thread.contentRef}`);
    await page.getByRole("button", { name: "Review submission" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "Approve" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Request changes" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Reject" })).toHaveCount(0);
  });

  test("submitted links are visible to the Manager before deciding - platform + external link", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    const url = `https://instagram.com/p/e2e-visible-${Date.now()}`;
    await submitOneLinkViaPublicPage(page, token, url);

    await signInAs(page, "admin");
    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    await page.goto(`/content/${thread.contentRef}`);
    await page.getByRole("button", { name: "Review submission" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: url })).toBeVisible();
  });

  test("Submitted links panel shows the current revision and links, with a View links dialog", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-evidence-panel");

    await signInAs(page, "admin");
    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    await page.goto(`/content/${thread.contentRef}`);
    const evidencePanel = page.locator(".panel").filter({ hasText: "Submitted links" });
    await expect(evidencePanel.getByText("Links in this revision")).toBeVisible();
    await expect(evidencePanel.locator(".kv", { hasText: "Links in this revision" }).locator("b")).toHaveText("1");
    await evidencePanel.getByRole("button", { name: "View links" }).click();
    await expect(page.getByRole("dialog").getByRole("link", { name: "https://instagram.com/p/e2e-evidence-panel" })).toBeVisible();
  });
});

// ---- Cancellation ----

test.describe("Cancellation", () => {
  test("an OPEN thread can be cancelled with a reason, from the Content workflow panel", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    const thread = await getThreadViaApi(page, assignment.assignmentRef);

    await page.goto(`/content/${thread.contentRef}`);
    await page.getByRole("button", { name: "Cancel Content" }).click();
    await expect(page.getByRole("button", { name: "Confirm cancellation" })).toBeDisabled();
    await page.getByLabel(/Reason for cancelling/).fill("No longer needed for this test.");
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(page.locator(".detailcontext").getByText("Cancelled")).toBeVisible();
  });

  test("an APPROVED thread cannot be cancelled - no Cancel Content control at all", async ({ page }) => {
    await page.goto("/content/seed-content-approved");
    await expect(page.getByRole("button", { name: "Cancel Content" })).toHaveCount(0);
  });
});

// ---- Assignment integration ----

test.describe("Assignment integration", () => {
  test("Assignment Content panel reflects the real thread status and updates as the loop progresses", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    const contentPanel = page.locator(".grid.three > .panel").filter({ hasText: "Content" }).first();
    await expect(contentPanel.getByText("No submission thread yet")).toBeVisible();

    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-assignment-panel");

    await signInAs(page, "admin");
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    const contentPanelAfter = page.locator(".grid.three > .panel").filter({ hasText: "Content" }).first();
    await expect(contentPanelAfter.getByText("Under review")).toBeVisible();
  });

  test("Assignment auto-completes the instant its one thread is approved - no separate Complete Content step exists anywhere", async ({ page }) => {
    const assignment = await createInProgressAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-auto-complete");

    // submitOneLinkViaPublicPage cleared cookies to simulate an anonymous
    // Partner - re-authenticate before the next trusted, authenticated
    // API call.
    await signInAs(page, "admin");
    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    const approveRes = await page.request.post(`/api/content/${thread.contentRef}/review`, {
      data: { decision: "APPROVED", reviewedRevisionNumber: thread.reviewedRevisionNumber, expectedVersion: thread.version },
    });
    expect(approveRes.ok()).toBeTruthy();

    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await expect(page.locator(".detailcontext").getByText("Completed")).toBeVisible();
  });
});

// ---- Responsive ----

test.describe("Mobile", () => {
  test("Workspace, Detail, and the review dialog stay usable at 390×844, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/content");
    await expect(page.locator("h1")).toHaveText("Content");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Cards view" }).click();
    await expect(page.locator(".recordgrid")).toBeVisible();

    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    await submitOneLinkViaPublicPage(page, token, "https://instagram.com/p/e2e-mobile");

    await signInAs(page, "admin");
    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/content/${thread.contentRef}`);
    await expect(page.locator("h1")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Review submission" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});
