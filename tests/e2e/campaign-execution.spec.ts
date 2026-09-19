import { test, expect, type Browser, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

// Step 12C - the real Campaign Execution integration end to end: a
// Campaign's real Assignment/Content/Analytics-composed data reaching the
// real Campaign Overview page. Runs in the default `chromium` project,
// pre-authenticated as admin@creatorops.com (Super Admin, GLOBAL scope) -
// same baseline as campaigns.spec.ts/assignments.spec.ts.
//
// Sections 17-22 (a "Create Assignment" contextual action inside Campaign
// Detail's own Assignments/linked-records panel) are pre-authorized out
// of scope for this step - that panel is hardcoded JSX directly inside
// the protected src/features/campaigns/CampaignDetail.tsx with no
// non-protected extension point. Every Assignment below is therefore
// created via the EXISTING trusted API directly, mirroring
// assignments.spec.ts's own createAssignmentViaApi helper.

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

type CampaignApi = { campaignRef: string; version: number; name: string; status: string };
type AssignmentApi = { assignmentRef: string; version: number; status: string };
type ContentThreadApi = { contentRef: string; version: number; status: string; reviewedRevisionNumber: number | null };

async function createActiveCampaignViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<CampaignApi> {
  const created = await page.request.post("/api/campaigns", {
    data: {
      name: uniqueName("Execution E2E Campaign"),
      objective: "Step 12C execution-integration E2E coverage.",
      platforms: ["instagram"],
      startDate: "2026-01-01",
      endDate: "2026-12-01",
      regionIds: ["Kerala"],
      defaultReviewPolicy: "REVIEW_REQUIRED",
      ...overrides,
    },
  });
  expect(created.ok()).toBeTruthy();
  const campaign = (await created.json()) as CampaignApi;

  const planned = await page.request.post(`/api/campaigns/${campaign.campaignRef}/lifecycle`, { data: { to: "PLANNED", expectedVersion: campaign.version } });
  expect(planned.ok()).toBeTruthy();
  const plannedBody = (await planned.json()) as { version: number };

  const activated = await page.request.post(`/api/campaigns/${campaign.campaignRef}/lifecycle`, { data: { to: "ACTIVE", expectedVersion: plannedBody.version } });
  expect(activated.ok()).toBeTruthy();
  const activatedBody = (await activated.json()) as { version: number; status: string };

  return { ...campaign, version: activatedBody.version, status: activatedBody.status };
}

async function createAssignmentViaApi(page: Page, campaignRef: string, overrides: Record<string, unknown> = {}): Promise<AssignmentApi> {
  const response = await page.request.post("/api/assignments", {
    data: { campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] }, ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AssignmentApi;
}

async function transitionAssignmentViaApi(page: Page, assignmentRef: string, to: string, expectedVersion: number): Promise<AssignmentApi> {
  const response = await page.request.post(`/api/assignments/${assignmentRef}/lifecycle`, { data: { to, expectedVersion } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AssignmentApi;
}

// Drives a fresh Assignment all the way to IN_PROGRESS (issue/accept/
// start) - the real states a Partner submission is accepted from.
async function issueAndStartAssignmentViaApi(page: Page, campaignRef: string, overrides: Record<string, unknown> = {}): Promise<AssignmentApi> {
  const created = await createAssignmentViaApi(page, campaignRef, overrides);
  const assigned = await transitionAssignmentViaApi(page, created.assignmentRef, "ASSIGNED", created.version);
  const accepted = await transitionAssignmentViaApi(page, created.assignmentRef, "ACCEPTED", assigned.version);
  const inProgress = await transitionAssignmentViaApi(page, created.assignmentRef, "IN_PROGRESS", accepted.version);
  return { ...created, ...inProgress };
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

// Publishes a real link through the actual public /submit/[token] page -
// no direct Firestore writes, no bypassing the real submission form.
async function submitLinkViaPublicPage(browser: Browser, baseURL: string | undefined, token: string, url: string): Promise<void> {
  // The public page is anonymous by design, so it must be visited from a
  // separate, cookie-free browser context - clearing cookies on the
  // authenticated `page` instead would silently log the staff session out
  // and turn every later page.request call into a 401.
  const context = await browser.newContext({ baseURL });
  try {
    const publicPage = await context.newPage();
    await publicPage.goto(`/submit/${token}`);
    await publicPage.getByLabel("Platform").first().selectOption("instagram");
    await publicPage.getByLabel("Published URL").first().fill(url);
    await publicPage.getByRole("button", { name: /Submit Links|Resubmit Links/ }).click();
    await expect(publicPage.getByText("Links submitted for review")).toBeVisible({ timeout: 5000 });
  } finally {
    await context.close();
  }
}

// Approves the Content thread through the real /content/[id] UI (Review
// submission -> Approve radio -> Record decision), not the raw API -
// proving the whole chain end to end through real pages, same dialog
// interaction content.spec.ts already uses.
async function approveViaContentUi(page: Page, contentRef: string): Promise<void> {
  await page.goto(`/content/${contentRef}`);
  await page.getByRole("button", { name: "Review submission" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Approve" }).check();
  await dialog.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText("Approved — closed")).toBeVisible({ timeout: 5000 });
}

// Loads a fresh /campaigns and parses the "Content completed" KPI ("N of M
// assigned obligations") into numbers - the shared emulator dataset already
// holds other obligations, so tests compare deltas, never absolute strings.
async function readContentCompleted(page: Page): Promise<{ approved: number; total: number }> {
  await page.goto("/campaigns");
  const text = (await page.locator(".ov-kpi").filter({ hasText: "Content completed" }).locator(".ov-kpi-value").innerText()).trim();
  const match = /^(\d+) of (\d+)/.exec(text);
  if (!match) throw new Error(`Unexpected "Content completed" KPI text: "${text}"`);
  return { approved: Number(match[1]), total: Number(match[2]) };
}

function workbookBuffer(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Content");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test.describe("Campaign Execution integration - full lifecycle", () => {
  test("issue -> accept -> start -> public submit -> Manager approves -> Assignment completes -> Overview reflects truthfully -> Campaign stays ACTIVE", async ({ page, browser, baseURL }) => {
    const campaign = await createActiveCampaignViaApi(page);
    const assignment = await issueAndStartAssignmentViaApi(page, campaign.campaignRef);

    // Before any submission: the fresh obligation is real (it is already
    // counted in the total, being IN_PROGRESS) but not yet approved - the
    // Overview must never fabricate completion. The KPI is compared as
    // parsed numbers, never as a substring, because the shared emulator
    // dataset legitimately already contains other approved obligations.
    const before = await readContentCompleted(page);
    expect(before.total).toBeGreaterThanOrEqual(1);

    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    const publicUrl = `https://instagram.com/p/exec-e2e-${Date.now()}`;
    await submitLinkViaPublicPage(browser, baseURL, token, publicUrl);

    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    expect(thread.status).toBe("UNDER_REVIEW");

    // ---- Overview must NOT show this obligation as complete while
    // Content is UNDER_REVIEW: a submitted link is not an approval, so the
    // approved numerator and the total are both unchanged. ----
    const underReview = await readContentCompleted(page);
    expect(underReview.approved).toBe(before.approved);
    expect(underReview.total).toBe(before.total);
    // The Campaign's own row (if it renders in the capped top-4 board) must never already show 100%.
    const campaignBoardCard = page.locator(".ov-campaign-card").filter({ hasText: campaign.name });
    if (await campaignBoardCard.count()) {
      await expect(campaignBoardCard.getByText("100%")).toHaveCount(0);
    }

    // ---- Manager approves through the real Content UI ----
    await approveViaContentUi(page, thread.contentRef);

    const approvedThread = await getThreadViaApi(page, assignment.assignmentRef);
    expect(approvedThread.status).toBe("APPROVED");

    // Approval auto-completes the Assignment (existing, pre-built content-
    // lifecycle-service.ts behavior - this integration step never itself
    // calls any Assignment lifecycle-mutation function).
    const assignmentAfter = await page.request.get(`/api/assignments/${assignment.assignmentRef}`);
    const assignmentAfterBody = (await assignmentAfter.json()) as { status: string };
    expect(assignmentAfterBody.status).toBe("COMPLETED");

    // ---- A fresh /campaigns load now shows the updated numbers: exactly
    // one more approved obligation, and the same total (approval never
    // creates or removes an obligation). ----
    const after = await readContentCompleted(page);
    expect(after.approved).toBe(before.approved + 1);
    expect(after.total).toBe(before.total);
    await expect(page.locator(".ov-panel h2")).toContainText(["Campaign Execution", "Delivery State", "Staffing Readiness", "Tracking Readiness", "Execution Exceptions", "Recent Activity", "Quick Actions"]);

    const campaignBoardCardAfter = page.locator(".ov-campaign-card").filter({ hasText: campaign.name });
    await expect(campaignBoardCardAfter).toBeVisible({ timeout: 5000 });
    await expect(campaignBoardCardAfter.getByText("100%")).toBeVisible();
    // Canonical terminology: "obligations approved", never the retired "deliverables".
    await expect(campaignBoardCardAfter.getByText("obligations approved")).toBeVisible();
    await expect(campaignBoardCardAfter.getByText(/deliverable/i)).toHaveCount(0);

    // ---- Campaign lifecycle must stay ACTIVE throughout ----
    const campaignAfter = await page.request.get(`/api/campaigns/${campaign.campaignRef}`);
    const campaignAfterBody = (await campaignAfter.json()) as { status: string };
    expect(campaignAfterBody.status).toBe("ACTIVE");

    // ---- Zero Finance records/routes touched anywhere in this flow ----
    for (const financeTerm of ["Agreement", "Payable", "Invoice", "Payment", "Payee", "compensation"]) {
      await expect(page.locator("#main")).not.toContainText(financeTerm);
    }
    const financeRoute = await page.request.get("/finance");
    expect(financeRoute.status()).not.toBe(500); // real page, never crashed by anything this step touched
  });

  test("a past-due, unresolved obligation counts as Overdue content and never marks the Assignment/Campaign as done", async ({ page }) => {
    const campaign = await createActiveCampaignViaApi(page);
    // brief.dueAt far in the past, left ASSIGNED (never accepted/started/
    // approved) - a genuine, currently-open overdue obligation.
    const assignment = await createAssignmentViaApi(page, campaign.campaignRef, { brief: { platforms: ["instagram"], dueAt: "2000-01-01T00:00:00.000Z" } });
    await transitionAssignmentViaApi(page, assignment.assignmentRef, "ASSIGNED", assignment.version);

    await page.goto("/campaigns");
    const overdueKpi = page.locator(".ov-kpi").filter({ hasText: "Overdue content" });
    await expect(overdueKpi.locator(".ov-kpi-value")).not.toHaveText("0", { timeout: 5000 });
    await expect(overdueKpi.locator(".ov-kpi-value")).not.toHaveText("—");

    const assignmentStatus = await page.request.get(`/api/assignments/${assignment.assignmentRef}`);
    expect(((await assignmentStatus.json()) as { status: string }).status).toBe("ASSIGNED"); // never auto-advanced by merely being overdue

    const campaignStatus = await page.request.get(`/api/campaigns/${campaign.campaignRef}`);
    expect(((await campaignStatus.json()) as { status: string }).status).toBe("ACTIVE");
  });

  test("Analytics import changes Tracking Readiness but never mutates Campaign lifecycle or Content/Assignment status", async ({ page, browser, baseURL }) => {
    const campaign = await createActiveCampaignViaApi(page);
    const assignment = await issueAndStartAssignmentViaApi(page, campaign.campaignRef);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);
    const publicUrl = `https://instagram.com/p/analytics-e2e-${Date.now()}`;
    await submitLinkViaPublicPage(browser, baseURL, token, publicUrl);

    const thread = await getThreadViaApi(page, assignment.assignmentRef);
    await approveViaContentUi(page, thread.contentRef);

    // The Analytics content-matcher only ever matches an APPROVED Content
    // thread's real currentLinks URL (see content-matcher.ts) - the
    // just-approved link above is a genuine match target.
    const buffer = workbookBuffer([
      ["Post URL", "Comments", "Likes"],
      [publicUrl, "4", "12"],
    ]);
    const importResponse = await page.request.post("/api/imports/execute", {
      data: { module: "analytics", targetKind: "campaign_content", filename: `exec-e2e-${Date.now()}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileBase64: buffer.toString("base64") },
    });
    expect(importResponse.ok()).toBeTruthy();
    const importBody = (await importResponse.json()) as { counts: { matched: number } };
    expect(importBody.counts.matched).toBe(1);

    // Content/Assignment status are untouched by the Analytics arrival -
    // this integration is strictly read-only downstream of Analytics.
    const contentAfterImport = await getThreadViaApi(page, assignment.assignmentRef);
    expect(contentAfterImport.status).toBe("APPROVED");
    const assignmentAfterImport = await page.request.get(`/api/assignments/${assignment.assignmentRef}`);
    expect(((await assignmentAfterImport.json()) as { status: string }).status).toBe("COMPLETED"); // unchanged from approval, not re-triggered by the import

    // Campaign lifecycle stays ACTIVE - an Analytics import must never be
    // able to move a Campaign's own status.
    const campaignAfterImport = await page.request.get(`/api/campaigns/${campaign.campaignRef}`);
    expect(((await campaignAfterImport.json()) as { status: string }).status).toBe("ACTIVE");

    // Tracking Readiness reflects the real, newly-linked Analytics data.
    await page.goto("/campaigns");
    const trackingPanel = page.locator(".ov-panel").filter({ has: page.getByRole("heading", { name: "Tracking Readiness" }) });
    await expect(trackingPanel.getByText("Tracking configured")).toBeVisible({ timeout: 5000 });
    await expect(trackingPanel.locator(".ov-badge").first()).not.toHaveText("Not built");
  });
});
