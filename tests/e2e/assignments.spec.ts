import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 10B - focused Assignment UI E2E. This file runs in the default
// `chromium` project, pre-authenticated as admin@creatorops.com (Super
// Admin, GLOBAL scope) via the shared storageState - same baseline as
// campaigns.spec.ts/vendors.spec.ts/partners.spec.ts. Tests that need a
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

// Creates a fresh, Manager/Head-reachable (Kerala-scoped) Campaign,
// drives it to PLANNED, then creates an Assignment under it - a genuinely
// fresh (campaignRef, partnerRef) pair every time (seed-partner-direct is
// already paired with every seeded PLANNED/ACTIVE Campaign, so a fresh
// Campaign is required to avoid colliding with the seed fixtures' own
// canonical-Assignment claims).
async function createAssignmentViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<AssignmentApi> {
  const campaignResponse = await page.request.post("/api/campaigns", {
    data: { name: uniqueName("Assignment UI Test Campaign"), objective: "x", platforms: ["instagram"], startDate: "2026-01-01", endDate: "2026-06-01", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" },
  });
  expect(campaignResponse.ok()).toBeTruthy();
  const campaign = (await campaignResponse.json()) as { campaignRef: string; version: number };
  const planned = await page.request.post(`/api/campaigns/${campaign.campaignRef}/lifecycle`, { data: { to: "PLANNED", expectedVersion: campaign.version } });
  expect(planned.ok()).toBeTruthy();

  const response = await page.request.post("/api/assignments", {
    data: { campaignRef: campaign.campaignRef, partnerRef: "seed-partner-direct", brief: { platforms: ["instagram"] }, ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AssignmentApi;
}

async function transitionViaApi(page: Page, assignmentRef: string, to: string, expectedVersion: number, reason?: string): Promise<AssignmentApi> {
  const response = await page.request.post(`/api/assignments/${assignmentRef}/lifecycle`, { data: { to, expectedVersion, reason } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as AssignmentApi;
}

// Step 10C - a fresh Assignment already moved to ASSIGNED (share-eligible),
// against a given partnerRef (defaults to seed-partner-direct; pass
// "creator-house" for the Vendor-option tests - it has a real active
// Vendor, seed-vendor-agency).
async function createAssignedAssignmentViaApi(page: Page, partnerRef = "seed-partner-direct"): Promise<AssignmentApi> {
  const created = await createAssignmentViaApi(page, { partnerRef });
  // The lifecycle endpoint's own response body is only {version, status} -
  // no assignmentRef (see assignment-lifecycle-service.ts) - so it must be
  // merged back onto `created`, never returned on its own.
  const transitioned = await transitionViaApi(page, created.assignmentRef, "ASSIGNED", created.version);
  return { ...created, ...transitioned };
}

// Every seeded ACTIVE Partner already has a real active Vendor link (see
// seed-vendors-data.ts) - a genuinely vendor-less Partner needs a fresh
// one created here for the "no Vendor option" case.
async function createVendorlessPartnerRefViaApi(page: Page): Promise<string> {
  const response = await page.request.post("/api/partners", { data: { displayName: uniqueName("Vendor-less Partner") } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { partnerRef: string };
  return body.partnerRef;
}

// Creates a real, single-use PARTNER submission session via the already-
// accepted trusted API and returns its raw bearer token - the same
// primitive the WhatsApp share dialog itself calls, used here to drive
// the public /submit/[token] page tests directly without the UI.
async function createSubmissionTokenViaApi(page: Page, assignmentRef: string): Promise<string> {
  const response = await page.request.post(`/api/assignments/${assignmentRef}/submission-sessions`, { data: { recipientType: "PARTNER" } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { rawToken: string };
  return body.rawToken;
}

// ---- Authorization ----

test.describe("Authorization", () => {
  test("Viewer is denied (nav + direct route)", async ({ page }) => {
    await signInAs(page, "viewer");
    await expect(page.locator('nav[aria-label="Global navigation"]').getByRole("link", { name: "Assignments" })).not.toBeVisible();
    await page.goto("/assignments");
    await expect(page).toHaveURL(/\/access-denied\?feature=assignments/);
  });

  test("Analyst is denied (nav + direct route)", async ({ page }) => {
    await signInAs(page, "analyst");
    await expect(page.locator('nav[aria-label="Global navigation"]').getByRole("link", { name: "Assignments" })).not.toBeVisible();
    await page.goto("/assignments");
    await expect(page).toHaveURL(/\/access-denied\?feature=assignments/);
  });

  test("Manager has scoped access - in-scope Assignment succeeds", async ({ page }) => {
    await signInAs(page, "manager");
    const assignment = await createAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  });

  test("Manager cross-scope Assignment is denied", async ({ page }) => {
    await signInAs(page, "manager");
    // seed-assignment-assigned sits under civic-voices, whose empty scope
    // snapshot makes it reachable only via GLOBAL (Super Admin) - not
    // even Head's own explicit CAMPAIGN grant on civic-voices bridges
    // into it (see Step 10A's own scope-snapshot design).
    await page.goto("/assignments/seed-assignment-assigned");
    await expect(page.getByText("Access denied")).toBeVisible();
  });

  test("Head has scoped access to a real in-scope Assignment", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/assignments/seed-assignment-draft");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  });

  test("Super Admin (GLOBAL) reaches every Assignment", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-in-progress");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  });
});

// ---- Workspace ----

test.describe("Workspace", () => {
  test("shows real seeded rows with current terminology, no raw refs, no legacy terms", async ({ page }) => {
    await page.goto("/assignments");
    await expect(page.locator("h1")).toHaveText("Assignments");
    await expect(page.getByRole("columnheader", { name: "Record" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Context" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Region" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();

    // Real Partner display names, never raw refs like "seed-partner-direct".
    await expect(page.getByText("Meera Krishnan").first()).toBeVisible();
    // Scoped to the page's own content, excluding the global AppShell nav
    // (whose own brand name is literally "CreatorOps" - not the legacy
    // "Creator" terminology this checks for).
    const bodyText = await page.locator("#main").innerText();
    expect(bodyText).not.toContain("seed-partner-");
    expect(bodyText).not.toContain("seed-campaign-");
    for (const legacy of ["Creator assignment", "Creator staffed", "Deliverable", "Agreement", "Payable", "Invoice", "Finance readiness"]) {
      expect(bodyText).not.toContain(legacy);
    }
    // Content-review states never appear as Assignment statuses.
    for (const contentState of ["Submitted", "Revision requested"]) {
      expect(bodyText).not.toContain(contentState);
    }
  });

  test("status filter re-queries real data, and Clear filters resets it", async ({ page }) => {
    await page.goto("/assignments");
    await page.getByLabel("Filter status").selectOption("CANCELLED");
    await expect(page.locator("tbody").getByText("Cancelled").first()).toBeVisible();
    const rowsAfterFilter = await page.locator("tbody tr").count();
    expect(rowsAfterFilter).toBeGreaterThan(0);

    // Every visible status pill should be Cancelled while the filter is active.
    const statusCells = await page.locator("tbody tr td:nth-child(2)").allTextContents();
    expect(statusCells.every((s) => s.trim() === "Cancelled")).toBe(true);

    await page.getByLabel("Filter status").selectOption("all");
    await expect(page.getByLabel("Filter status")).toHaveValue("all");
  });

  test("the page-scoped search filters currently-loaded rows honestly (explicit caption present)", async ({ page }) => {
    await page.goto("/assignments");
    await expect(page.getByText("Searches the assignments currently loaded on this page.")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search records" }).fill("Meera Krishnan");
    await expect(page.getByText("Meera Krishnan").first()).toBeVisible();
    await page.getByRole("searchbox", { name: "Search records" }).fill("no-such-partner-xyz");
    await expect(page.getByText("No matching Assignments")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("Meera Krishnan").first()).toBeVisible();
  });

  test("density and table/card layout toggles work, no data implication", async ({ page }) => {
    await page.goto("/assignments");
    await expect(page.getByRole("button", { name: "Cards view" })).toBeVisible();
    await page.getByRole("button", { name: "Cards view" }).click();
    await expect(page.locator(".recordgrid")).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.locator("table")).toBeVisible();
    await page.getByRole("button", { name: /Compact rows|Comfortable rows/ }).click();
  });

  test("row navigation opens the real Detail page", async ({ page }) => {
    await page.goto("/assignments");
    await page.getByRole("button", { name: /Inspect/ }).first().click();
    await expect(page).toHaveURL(/\/assignments\/[^/]+$/);
    await expect(page.locator(".eyebrow", { hasText: "ASSIGNMENTS / RECORD DETAIL" })).toBeVisible();
  });
});

// ---- Detail ----

test.describe("Detail", () => {
  test("shows the exact frozen panel structure with correct Campaign + Partner context", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-draft");
    await expect(page.locator(".eyebrow")).toHaveText("ASSIGNMENTS / RECORD DETAIL");
    await expect(page.locator("h1")).toHaveText("Meera Krishnan");
    await expect(page.getByText("South Programmes Launch").first()).toBeVisible();

    // Frozen 4-box context strip labels.
    for (const label of ["Status", "Responsible owner", "Region", "Last updated"]) {
      await expect(page.locator(".detailcontext").getByText(label, { exact: true })).toBeVisible();
    }

    // Frozen tab/action strip + scope chip.
    await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Notes & meetings" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "History" })).toBeVisible();
    await expect(page.getByText("Authorized record preview")).toBeVisible();

    // Frozen panel titles.
    await expect(page.getByRole("heading", { name: "Record context" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Next action" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Content" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Assignment workflow" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes & meetings" })).toBeVisible();

    // Record context's exact archetype: paragraph + 4 kv rows. "Due date"
    // also appears a second time in Assignment workflow (by design - see
    // that panel's own kv rows), so scope this check to Record context.
    const recordContext = page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Record context" }) });
    for (const label of ["Campaign", "Partner", "Platform / account context", "Due date"]) {
      await expect(recordContext.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("frozen brief snapshot never changes after a Campaign edit", async ({ page }) => {
    const assignment = await createAssignmentViaApi(page);
    const before = await page.request.get(`/api/assignments/${assignment.assignmentRef}`);
    const beforeBody = (await before.json()) as { campaignRef: string; brief: { campaignName: string } };
    expect(beforeBody.brief.campaignName).toBeTruthy();

    const campaignBefore = await page.request.get(`/api/campaigns/${beforeBody.campaignRef}`);
    const campaign = (await campaignBefore.json()) as { version: number };
    await page.request.patch(`/api/campaigns/${beforeBody.campaignRef}`, { data: { name: "Renamed After Issuance", expectedVersion: campaign.version } });

    await page.goto(`/assignments/${assignment.assignmentRef}`);
    // The Detail page renders the FROZEN brief.campaignName (header
    // subtitle + Record context's own Campaign row), never the live-
    // resolved DTO field - a later Campaign rename must never visually
    // replace this historical identity.
    await expect(page.locator("p", { hasText: beforeBody.brief.campaignName }).first()).toBeVisible();
    await expect(page.getByText("Renamed After Issuance")).toHaveCount(0);
  });

  test("Content section shows a neutral not-built state, never fake progress", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-draft");
    const contentPanel = page.locator(".grid.three > .panel").filter({ hasText: "Content" }).first();
    await expect(contentPanel.getByText("Not yet built")).toBeVisible();
    await expect(contentPanel.getByText("No real trusted source is wired to this Assignment yet.")).toBeVisible();
  });

  test("no sharing/WhatsApp/public-link controls are rendered anywhere", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-draft");
    for (const forbidden of ["Copy Campaign Brief Link", "Share via WhatsApp", "Include public submission link"]) {
      await expect(page.getByText(forbidden)).toHaveCount(0);
    }
  });

  test("Notes & meetings shows a truthful unavailable state, both as a panel and as a dialog", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-draft");
    const notesPanel = page.locator(".grid.three > .panel").filter({ hasText: "Notes & meetings" }).first();
    await expect(notesPanel.getByText("Not yet built")).toBeVisible();

    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.getByRole("dialog").getByText("Not yet built")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
  });

  test("History dialog shows real events for an Assignment created through the trusted service", async ({ page }) => {
    const assignment = await createAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByRole("dialog").getByText("Assignment created")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});

// ---- Lifecycle ----

test.describe("Lifecycle", () => {
  test("DRAFT -> ASSIGNED (Issue Assignment) -> ACCEPTED (Mark Accepted) -> IN_PROGRESS (Start Work)", async ({ page }) => {
    const assignment = await createAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);

    await expect(page.getByRole("button", { name: "Issue Assignment" })).toBeVisible();
    await page.getByRole("button", { name: "Issue Assignment" }).click();
    await expect(page.locator(".detailcontext").getByText("Assigned")).toBeVisible();

    await expect(page.getByRole("button", { name: "Mark Accepted" })).toBeVisible();
    await page.getByRole("button", { name: "Mark Accepted" }).click();
    await expect(page.locator(".detailcontext").getByText("Accepted")).toBeVisible();

    await expect(page.getByRole("button", { name: "Start Work" })).toBeVisible();
    await page.getByRole("button", { name: "Start Work" }).click();
    await expect(page.locator(".detailcontext").getByText("In Progress")).toBeVisible();

    // Now IN_PROGRESS - no actionable Complete button anywhere, only the
    // neutral pending-Content text.
    await expect(page.getByText("Completion pending Content - not available yet")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Mark Completed$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Complete/ })).toHaveCount(0);
  });

  test("legal cancellation requires a reason and succeeds", async ({ page }) => {
    const assignment = await createAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await page.getByRole("button", { name: "Cancel assignment" }).click();
    // Empty reason - the Confirm button is disabled client-side, never a
    // hung/ignored click.
    await expect(page.getByRole("button", { name: "Confirm cancellation" })).toBeDisabled();

    await page.getByLabel(/Reason for cancelling/).fill("No longer needed for this test.");
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    await expect(page.locator(".detailcontext").getByText("Cancelled")).toBeVisible();
    await expect(page.getByText("No longer needed for this test.")).toBeVisible();
  });

  test("cancellation blocked by existing external-submission evidence shows the real business-safe message", async ({ page }) => {
    // seed-assignment-assigned is the one seed fixture with a real, USED
    // external submission session and its own immutable submission batch
    // (see seed-assignments-data.ts's "seed-session-used"/"seed-submission-1") -
    // reachable only via Super Admin's GLOBAL scope (this file's default
    // authenticated identity).
    await page.goto("/assignments/seed-assignment-assigned");
    await page.getByRole("button", { name: "Cancel assignment" }).click();
    await page.getByLabel(/Reason for cancelling/).fill("Trying anyway.");
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    // The blockers banner (not the generic error string) is what renders
    // here, matching Campaign's own not_ready precedent exactly - the
    // blocker's own message is the real backend text from
    // assignment-lifecycle-service.ts's EXTERNAL_EVIDENCE_EXISTS blocker.
    await expect(page.getByText("Not ready.")).toBeVisible();
    await expect(page.getByText(/At least one external submission batch already exists for this Assignment/)).toBeVisible();
    // Status must NOT have changed - the block is real, not cosmetic.
    await expect(page.locator(".detailcontext").getByText("Assigned", { exact: true })).toBeVisible();
  });

  test("completion stays unavailable/not-ready until Content exists - never a fake success path", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-in-progress");
    await expect(page.getByText("Completion pending Content - not available yet")).toBeVisible();
    await expect(page.getByRole("button", { name: /Complete/ })).toHaveCount(0);
  });

  test("a stale expectedVersion shows a clear conflict, never a silently-forced UI state", async ({ page }) => {
    const assignment = await createAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);

    // Bump the version server-side out from under the open page.
    await transitionViaApi(page, assignment.assignmentRef, "ASSIGNED", assignment.version);

    await page.getByRole("button", { name: "Issue Assignment" }).click();
    await expect(page.getByText(/changed elsewhere|Forbidden|Cannot move/i)).toBeVisible();
    // The UI must not have optimistically jumped to Assigned on its own -
    // it should still show the stale banner rather than a silently-forced new state.
  });
});

// ---- WhatsApp sharing (Step 10C) ----

test.describe("WhatsApp sharing", () => {
  test("the header action only appears for ASSIGNED/ACCEPTED/IN_PROGRESS, never DRAFT/COMPLETED/CANCELLED", async ({ page }) => {
    await page.goto("/assignments/seed-assignment-draft");
    await expect(page.getByRole("button", { name: "Share via WhatsApp" })).toHaveCount(0);

    const assignment = await createAssignedAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await expect(page.getByRole("button", { name: "Share via WhatsApp" })).toBeVisible();
  });

  test("checkbox OFF: opening/toggling the dialog and confirming never creates a submission session", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);

    let sessionCalls = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/submission-sessions")) sessionCalls += 1;
    });

    await page.getByRole("button", { name: "Share via WhatsApp" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Share Assignment via WhatsApp")).toBeVisible();
    const checkbox = dialog.getByRole("checkbox", { name: "Include public submission link" });
    await expect(checkbox).not.toBeChecked();
    expect(sessionCalls).toBe(0);

    // Toggling on/off without confirming must never call the API either.
    await checkbox.check();
    await expect(dialog.getByText("Submission recipient")).toBeVisible();
    await checkbox.uncheck();
    await expect(dialog.getByText("Submission recipient")).toHaveCount(0);
    expect(sessionCalls).toBe(0);

    // Safe preview text is present, with no /submit/ URL and no raw refs,
    // while OFF.
    const preview = dialog.locator(".scopebox");
    await expect(preview).toContainText("Assignment for");
    await expect(preview).not.toContainText("/submit/");
    await expect(preview).not.toContainText(assignment.assignmentRef);

    const [popup] = await Promise.all([page.waitForEvent("popup"), dialog.getByRole("button", { name: "Open WhatsApp" }).click()]);
    await popup.waitForURL(/wa\.me|whatsapp\.com/, { waitUntil: "commit", timeout: 10_000 });
    expect(decodeURIComponent(popup.url())).not.toContain("/submit/");
    await popup.close();

    expect(sessionCalls).toBe(0);
  });

  test("checkbox ON / Partner: final confirmation creates exactly one session and the WhatsApp message carries exactly one /submit/ URL", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);

    let sessionCalls = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/submission-sessions")) sessionCalls += 1;
    });

    await page.getByRole("button", { name: "Share via WhatsApp" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "Include public submission link" }).check();
    await expect(dialog.getByRole("radio", { name: "Partner" })).toBeChecked();

    const [popup] = await Promise.all([page.waitForEvent("popup"), dialog.getByRole("button", { name: "Open WhatsApp" }).click()]);
    await popup.waitForURL(/wa\.me|whatsapp\.com/, { waitUntil: "commit", timeout: 10_000 });
    const message = decodeURIComponent(popup.url());
    const submitUrlCount = (message.match(/\/submit\//g) ?? []).length;
    expect(submitUrlCount).toBe(1);
    await popup.close();

    expect(sessionCalls).toBe(1);

    // The dialog also exposes the generated link for copying - the same
    // session, not a second one.
    await expect(dialog.getByLabel("Generated submission link")).toBeVisible();
    expect(sessionCalls).toBe(1);

    // Never written to localStorage/sessionStorage.
    const storageDump = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
    expect(storageDump).not.toContain("/submit/");
  });

  test("double-click protection: the confirm button disables while creation is in flight, never issuing two sessions", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);

    let sessionCalls = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/submission-sessions")) sessionCalls += 1;
    });

    // The real local emulator round trip is fast enough that a bare
    // click-then-assert can race past the disabled window - hold the
    // response briefly so the in-flight state is reliably observable.
    await page.route("**/submission-sessions", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.getByRole("button", { name: "Share via WhatsApp" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "Include public submission link" }).check();

    // Located by its stable footer position, not by name - its own
    // accessible name changes to "Creating link…" once busy, so a
    // name-bound locator would stop matching anything at exactly the
    // moment this test needs to observe it.
    const confirmButton = dialog.locator(".dialogfoot button.primary");
    await expect(confirmButton).toHaveText("Open WhatsApp");
    const [popup] = await Promise.all([page.waitForEvent("popup"), confirmButton.click()]);

    // Still genuinely in flight (the 500ms delayed response above), the
    // button is disabled and its own label reflects the in-flight state -
    // real browsers never deliver a click to a disabled button, so this
    // is what actually prevents a second session, not just cosmetic.
    await expect(confirmButton).toBeDisabled();
    await expect(confirmButton).toHaveText("Creating link…");

    await popup.waitForURL(/wa\.me|whatsapp\.com/, { waitUntil: "commit", timeout: 10_000 });
    await popup.close();

    expect(sessionCalls).toBe(1);
  });

  test("Vendor option appears only when a current active Vendor exists, and shows only the safe display label", async ({ page }) => {
    const vendorlessPartnerRef = await createVendorlessPartnerRefViaApi(page);
    const withoutVendor = await createAssignedAssignmentViaApi(page, vendorlessPartnerRef);
    await page.goto(`/assignments/${withoutVendor.assignmentRef}`);
    await page.getByRole("button", { name: "Share via WhatsApp" }).click();
    const dialogA = page.getByRole("dialog");
    await dialogA.getByRole("checkbox", { name: "Include public submission link" }).check();
    await expect(dialogA.getByRole("radio", { name: "Partner" })).toBeVisible();
    await expect(dialogA.getByText(/Current Vendor/)).toHaveCount(0);
    await page.getByRole("button", { name: "Close dialog" }).click();

    // creator-house: real active Vendor, seed-vendor-agency / "Northline Talent Agency".
    const withVendor = await createAssignedAssignmentViaApi(page, "creator-house");
    await page.goto(`/assignments/${withVendor.assignmentRef}`);
    await page.getByRole("button", { name: "Share via WhatsApp" }).click();
    const dialogB = page.getByRole("dialog");
    await dialogB.getByRole("checkbox", { name: "Include public submission link" }).check();
    await expect(dialogB.getByText("Current Vendor — Northline Talent Agency")).toBeVisible();
    // No raw vendorRef ever shown.
    await expect(dialogB.getByText("seed-vendor-agency")).toHaveCount(0);
  });
});

// ---- Public submission page (Step 10C) ----

test.describe("Public submission page", () => {
  test("anonymous browser can open a valid token, sees no CreatorOps shell/nav, and cannot open /assignments", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    await expect(page.getByText("Submit published links")).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await expect(page.locator(".topbar")).toHaveCount(0);
    await expect(page.locator('nav[aria-label="Global navigation"]')).toHaveCount(0);

    await page.goto("/assignments");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("security headers: noindex/nofollow, referrer policy, no token in the document title", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /nofollow/);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    const title = await page.title();
    expect(title).not.toContain(token);
  });

  test("external resource links render with rel=noreferrer noopener", async ({ page }) => {
    // seed-assignment-assigned carries the seeded brief's real resourceLinks
    // (one shareExternally:true, one shareExternally:false - see
    // seed-assignments-data.ts's briefBase()); a freshly API-created
    // Assignment has no resourceLinks at all.
    const token = await createSubmissionTokenViaApi(page, "seed-assignment-assigned");

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    const link = page.getByRole("link", { name: "Public brand guidelines" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("rel", "noreferrer noopener");
    await expect(link).toHaveAttribute("target", "_blank");
    // The internal-only link never reaches this page at all.
    await expect(page.getByText("Internal negotiation notes")).toHaveCount(0);
  });

  test("default one row, add up to 10, remove control appears once there's more than one row", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    await expect(page.getByRole("button", { name: "Remove row" })).toHaveCount(0);

    for (let i = 0; i < 9; i += 1) await page.getByRole("button", { name: "+ Add another link" }).click();
    await expect(page.getByLabel("Published URL")).toHaveCount(10);
    await expect(page.getByRole("button", { name: "+ Add another link" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove row" }).first()).toBeVisible();
  });

  test("a valid multi-link submission succeeds, consumes the token, and a refresh shows the generic unavailable state", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);

    await page.getByLabel("Platform").first().selectOption("instagram");
    await page.getByLabel("Published URL").first().fill("https://instagram.com/p/e2e-1");
    await page.getByRole("button", { name: "+ Add another link" }).click();
    await page.getByLabel("Platform").nth(1).selectOption("instagram");
    await page.getByLabel("Published URL").nth(1).fill("https://instagram.com/p/e2e-2");

    await page.getByRole("button", { name: "Submit Links" }).click();
    await expect(page.getByText("Links submitted successfully")).toBeVisible();
    await expect(page.getByText("This submission link is no longer active.")).toBeVisible();

    await page.reload();
    await expect(page.getByText("This submission link is no longer available.")).toBeVisible();
    await expect(page.getByText("Please contact the CreatorOps team if you need a new link.")).toBeVisible();
  });

  test("duplicate platform+URL rows are rejected without consuming the token", async ({ page }) => {
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    await page.getByLabel("Platform").first().selectOption("instagram");
    await page.getByLabel("Published URL").first().fill("https://instagram.com/p/dup");
    await page.getByRole("button", { name: "+ Add another link" }).click();
    await page.getByLabel("Platform").nth(1).selectOption("instagram");
    await page.getByLabel("Published URL").nth(1).fill("https://instagram.com/p/dup");

    await page.getByRole("button", { name: "Submit Links" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Links submitted successfully")).toHaveCount(0);

    // The token is still usable after a validation error.
    await page.getByLabel("Published URL").nth(1).fill("https://instagram.com/p/not-a-dup");
    await page.getByRole("button", { name: "Submit Links" }).click();
    await expect(page.getByText("Links submitted successfully")).toBeVisible();
  });

  test("an invalid/unknown token shows the same generic unavailable state", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/submit/not-a-real-token-at-all");
    await expect(page.getByText("This submission link is no longer available.")).toBeVisible();
  });
});

// ---- Responsive ----

test.describe("Mobile", () => {
  test("Workspace and Detail remain usable at 390×844, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/assignments");
    await expect(page.locator("h1")).toHaveText("Assignments");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.goto("/assignments/seed-assignment-draft");
    await expect(page.locator("h1")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("WhatsApp share dialog stays usable at 390×844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const assignment = await createAssignedAssignmentViaApi(page);
    await page.goto(`/assignments/${assignment.assignmentRef}`);
    await page.getByRole("button", { name: "Share via WhatsApp" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Share Assignment via WhatsApp")).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Include public submission link" }).check();
    await expect(dialog.getByRole("radio", { name: "Partner" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open WhatsApp" })).toBeVisible();
  });

  test("public submission form stays usable at 390×844, no horizontal overflow, Add-another still works", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const assignment = await createAssignedAssignmentViaApi(page);
    const token = await createSubmissionTokenViaApi(page, assignment.assignmentRef);

    await page.context().clearCookies();
    await page.goto(`/submit/${token}`);
    await expect(page.getByText("Submit published links")).toBeVisible();
    await page.getByRole("button", { name: "+ Add another link" }).click();
    await expect(page.getByLabel("Published URL")).toHaveCount(2);

    const overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
