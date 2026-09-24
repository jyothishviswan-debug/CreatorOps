import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, noDocumentOverflow, waitForHydration } from "./helpers/finance-agreements-fixtures";
import { createOperationsFixtures, signInAs, VIEWPORTS, type OperationsFixtures } from "./helpers/operations-fixtures";

const expect = baseExpect.configure({ timeout: 20_000 });

// Step 18B e2e: the Operations UI suite (spec section 24's own scenario list - Tasks 1-6,
// Approval Queue 7-11, Reminders 12-16, Responsive 17-19).
//
// Hermetic: private-region fixtures via createOperationsFixtures, unique tag, removed in afterAll.
// Tasks/Reminders are seeded through the TRUSTED service layer (never the Operations UI's own
// create forms) so each test can start from a known lifecycle state; the create FLOW itself is
// separately exercised live through the real UI in its own test.

test.describe.configure({ mode: "serial" });

const TAG = `OPS${Date.now().toString(36)}`;
const fx: OperationsFixtures = createOperationsFixtures(TAG);

let managerUserRef = "";
let lifecycleTaskRef = "";

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

test.beforeAll(async () => {
  await fx.finance.grantFixtureRegion();
  const manager = await fx.finance.actorOf("manager");
  managerUserRef = manager.userRef;
});

test.afterAll(async () => {
  await fx.cleanupAll();
});

// ==========================================================================================
test.describe("Tasks", () => {
  test("1: workspace loads, shows the summary strip, filters, and a Create Task action", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/operations");
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
    await expect(page.getByTestId("tasks-status-strip")).toBeVisible();
    await expect(page.getByRole("link", { name: "Create Task" }).first()).toBeVisible();
    await waitForHydration(page, 'input[aria-label="Search tasks"]');
    expect(errors.errors).toEqual([]);
  });

  test("2: create Task linked to a canonical target, assigned to an active user", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Target Partner` });
    await signInAs(page, "head");
    await page.goto("/operations/tasks/new");
    await page.locator("#task-title").fill(`${TAG} created via UI`);
    await page.locator("#task-notes").fill("Created live through Playwright.");
    await page.locator("#task-priority").selectOption("HIGH");

    await page.locator("#target-search").fill(partner.displayName);
    await expect(page.getByTestId("target-option-row").first()).toBeVisible();
    await page.getByTestId("select-target").first().click();
    await expect(page.getByTestId("selected-target-summary")).toContainText(partner.displayName);

    await page.locator("#task-assignee").fill("manager@");
    await expect(page.getByTestId("assignee-option-row").first()).toBeVisible();
    await page.getByTestId("select-assignee").first().click();
    await expect(page.getByTestId("selected-assignee-summary")).toBeVisible();

    await page.getByTestId("submit-create-task").click();
    await page.waitForURL(/\/operations\/tasks\/tsk_/);
    await expect(page.getByRole("heading", { level: 1, name: `${TAG} created via UI` })).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("3: Start -> Block -> Resume -> Complete, each step reflected live", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Lifecycle Partner` });
    const task = await fx.seedTask({ title: `${TAG} Lifecycle Task`, targetType: "PARTNER", targetRef: partner.partnerRef, assigneeUserRef: managerUserRef });
    lifecycleTaskRef = task.taskRef;

    await signInAs(page, "head");
    await page.goto(`/operations/tasks/${task.taskRef}`);
    await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();

    await page.getByTestId("task-action-start").click();
    await expect(page.getByText("In progress", { exact: true }).first()).toBeVisible();

    await page.getByTestId("task-action-block").click();
    await page.getByTestId("lifecycle-reason-input").fill("Waiting on partner response.");
    await page.getByTestId("lifecycle-reason-confirm").click();
    await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible();

    await page.getByTestId("task-action-unblock").click();
    await expect(page.getByText("In progress", { exact: true }).first()).toBeVisible();

    await page.getByTestId("task-action-complete").click();
    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Read-only (Done)")).toBeVisible();

    expect(errors.errors).toEqual([]);
  });

  test("4: Edit Task changes permitted fields and is audited", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Edit Partner` });
    const task = await fx.seedTask({ title: `${TAG} Editable Task`, targetType: "PARTNER", targetRef: partner.partnerRef, assigneeUserRef: managerUserRef });

    await signInAs(page, "head");
    await page.goto(`/operations/tasks/${task.taskRef}`);
    await page.getByTestId("task-action-edit").click();
    await page.getByTestId("edit-task-title").fill(`${TAG} Editable Task (revised)`);
    await page.getByTestId("edit-task-reason").fill("Correcting the title.");
    await page.getByTestId("edit-task-submit").click();

    // DialogShell wraps a native <dialog> - its content stays IN THE DOM (closed via the imperative
    // .close() DOM API, not by unmounting), so a mere presence check would pass even while the dialog
    // is still open. Assert on visibility (native <dialog> hides its content via the UA stylesheet
    // when not open) and, load-bearingly, on the h1 actually reflecting the server's revised title.
    await expect(page.getByTestId("edit-task-submit")).not.toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: `${TAG} Editable Task (revised)` })).toBeVisible();

    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByTestId("task-activity-row").filter({ hasText: "Revised" })).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("Task target (the linked Partner record) remains byte-for-byte unchanged across a full lifecycle - Operations owns no target mutation", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Immutability Partner` });
    const before = await fx.snapshotPartner(partner.partnerRef);
    expect(before).not.toBeNull();

    const task = await fx.seedTask({ title: `${TAG} Immutability Task`, targetType: "PARTNER", targetRef: partner.partnerRef, assigneeUserRef: managerUserRef });

    await signInAs(page, "head");
    await page.goto(`/operations/tasks/${task.taskRef}`);
    await page.getByTestId("task-action-start").click();
    await expect(page.getByText("In progress", { exact: true }).first()).toBeVisible();
    await page.getByTestId("task-action-block").click();
    await page.getByTestId("lifecycle-reason-input").fill("Waiting on a reply.");
    await page.getByTestId("lifecycle-reason-confirm").click();
    await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible();
    await page.getByTestId("task-action-unblock").click();
    await expect(page.getByText("In progress", { exact: true }).first()).toBeVisible();
    await page.getByTestId("task-action-edit").click();
    await page.getByTestId("edit-task-title").fill(`${TAG} Immutability Task (revised)`);
    await page.getByTestId("edit-task-reason").fill("Small title fix.");
    await page.getByTestId("edit-task-submit").click();
    await expect(page.getByTestId("edit-task-submit")).not.toBeVisible();
    await page.getByTestId("task-action-complete").click();
    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();

    const after = await fx.snapshotPartner(partner.partnerRef);
    expect(after).toEqual(before);
    expect(errors.errors).toEqual([]);
  });

  test("5: Activity tab lists every lifecycle event in order", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/operations/tasks/${lifecycleTaskRef}`);
    await page.getByRole("tab", { name: "Activity" }).click();
    // Most-recent-first (task-service.ts's listTaskEventDocs orders createdAt desc).
    const rows = page.getByTestId("task-activity-row");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText("Completed");
    await expect(rows.nth(1)).toContainText("Unblocked");
    await expect(rows.nth(2)).toContainText("Blocked");
    await expect(rows.nth(3)).toContainText("Started");
    await expect(rows.nth(4)).toContainText("Created");
    expect(errors.errors).toEqual([]);
  });

  test("6: Viewer sees Tasks read-only - no Create action, no lifecycle actions", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "viewer");
    await page.goto("/operations");
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create Task" })).toHaveCount(0);
    await page.goto(`/operations/tasks/${lifecycleTaskRef}`);
    await expect(page.getByTestId("task-action-start")).toHaveCount(0);
    await expect(page.getByTestId("task-action-edit")).toHaveCount(0);
    expect(errors.errors).toEqual([]);
  });
});

// ==========================================================================================
test.describe("Approval Queue", () => {
  test("7-8: a real pending Partner Review appears, and Open source routes to the real record", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const { partner, reviewRef } = await fx.seedPendingApproval(`${TAG} Approval Partner`);
    await signInAs(page, "head");
    await page.goto("/operations/approvals");
    const row = page.getByTestId("approval-row").filter({ hasText: partner.displayName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Partner Review");
    await expect(row).toContainText("IN_REVIEW");

    // 11: no generic Approve/Reject/Resolve/Confirm button anywhere in Operations - the row's
    // ONLY interactive control is "Open source".
    for (const forbidden of ["Approve", "Reject", "Resolve", "Confirm", "Finalize"]) {
      await expect(row.getByRole("button", { name: forbidden })).toHaveCount(0);
      await expect(row.getByRole("link", { name: forbidden })).toHaveCount(0);
    }
    await expect(row.getByTestId("open-source")).toHaveAttribute("href", `/partner-reviews/${reviewRef}`);

    await row.getByTestId("open-source").click();
    await page.waitForURL(new RegExp(`/partner-reviews/${reviewRef}`));
    await expect(page.getByRole("button", { name: "Finalize" })).toBeVisible();

    await fx.finalizeReview(reviewRef);
    expect(errors.errors).toEqual([]);
  });

  test("9-10: finalizing the source review through its OWN module makes the item disappear from the queue on refresh", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const { partner, reviewRef } = await fx.seedPendingApproval(`${TAG} Disappear Partner`);
    await signInAs(page, "head");
    await page.goto("/operations/approvals");
    await expect(page.getByTestId("approval-row").filter({ hasText: partner.displayName })).toBeVisible();

    // The finalize action happens through Partner Reviews' OWN trusted service - never Operations.
    await fx.finalizeReview(reviewRef);

    await page.getByTestId("refresh-approval-queue").click();
    await expect(page.getByTestId("approval-row").filter({ hasText: partner.displayName })).toHaveCount(0);
    expect(errors.errors).toEqual([]);
  });

  test("11: no generic approval mutation control exists anywhere on the Approval Queue page (page-wide sweep, not just one row)", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const { partner } = await fx.seedPendingApproval(`${TAG} Sweep Partner`);
    await signInAs(page, "head");
    await page.goto("/operations/approvals");
    await expect(page.getByTestId("approval-row").filter({ hasText: partner.displayName })).toBeVisible();

    // No generic Approve/Reject/Resolve/Confirm/Finalize control anywhere on the WHOLE page - not
    // scoped to a single row. "Finalize" is legitimately allowed to appear on the Partner Review's
    // OWN page after following "Open source" (a separate page, asserted in 7-8), but must never
    // appear as a control ON the Approval Queue page itself.
    for (const forbidden of ["Approve", "Reject", "Resolve", "Confirm", "Finalize"]) {
      await expect(page.getByRole("button", { name: forbidden })).toHaveCount(0);
      await expect(page.getByRole("link", { name: forbidden })).toHaveCount(0);
    }
    // Only "Open source" is a real cross-module navigation control; every other interactive element
    // on the page is read-only (search/filter/refresh), never a mutation.
    const buttons = await page.getByRole("button").all();
    for (const button of buttons) {
      const name = (await button.textContent())?.trim() ?? "";
      expect(["Approve", "Reject", "Resolve", "Confirm", "Finalize", "Set status"]).not.toContain(name);
    }
    expect(errors.errors).toEqual([]);
  });

  test("17: a record-scope-limited item does not appear in the Approval Queue, even for an actor who otherwise holds full view_approval_queue (scope, not role)", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    // Partnership Head holds the SAME view_approval_queue grant as Manager (Step 18A's own "no
    // separate approval step" shape) - this proves the queue is additionally gated per-record by the
    // source module's own scope model, not just by the Operations feature/action grant. The Partner
    // backing this review lives in `finance.hiddenRegion`, a region grantFixtureRegion() never grants
    // to ANY fixture identity, so no seeded role (Head included) can see it - a genuine record-scope
    // denial, distinct from the role-based "Analyst cannot view Approval Queue at all" case below.
    const { partner, reviewRef } = await fx.seedScopedOutPendingApproval(`${TAG} Scoped Out Partner`);
    await signInAs(page, "head");
    await page.goto("/operations/approvals");
    await expect(page.getByTestId("approval-row").filter({ hasText: partner.displayName })).toHaveCount(0);
    // Existence is not leaked through any other surface on the page either (title/error text).
    await expect(page.getByText(partner.displayName)).toHaveCount(0);
    await expect(page.getByText(reviewRef)).toHaveCount(0);
    expect(errors.errors).toEqual([]);
  });

  test("Analyst cannot view the Approval Queue at all - neutral denial, no generic action leaks through", async ({ page }) => {
    // Analyst holds no "operations" feature grant at all (seed-access-data.ts), so this hits the
    // outer whole-module feature gate, not the inner canView Approval Queue guard - no seeded role
    // has base Operations access without view_approval_queue (Manager/Head both hold it together),
    // so that inner guard is defensive-only today. Either way the denial must be neutral, with
    // nothing from the Approval Queue itself leaking through.
    const errors = collectBrowserErrors(page);
    await signInAs(page, "analyst");
    await page.goto("/operations/approvals");
    await expect(page.getByRole("heading", { name: "You don" })).toBeVisible();
    await expect(page.getByTestId("approval-row")).toHaveCount(0);
    expect(errors.errors).toEqual([]);
  });
});

// ==========================================================================================
test.describe("Reminders", () => {
  let reminderRef = "";

  test("12: create a scheduled Reminder through the real UI", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Reminder Partner` });
    await signInAs(page, "head");
    await page.goto("/operations/reminders/new");
    await page.locator("#reminder-message").fill(`${TAG} follow up`);
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await page.locator("#reminder-at").fill(future.toISOString().slice(0, 16));

    await page.locator("#target-search").fill(partner.displayName);
    await expect(page.getByTestId("target-option-row").first()).toBeVisible();
    await page.getByTestId("select-target").first().click();

    await page.locator("#reminder-owner").fill("head@");
    await expect(page.getByTestId("assignee-option-row").first()).toBeVisible();
    await page.getByTestId("select-assignee").first().click();

    await page.getByTestId("submit-create-reminder").click();
    await page.waitForURL(/\/operations\/reminders\/rmd_/);
    reminderRef = page.url().split("/").pop()!;
    await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("13: reschedule moves the reminder time and is audited", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/operations/reminders/${reminderRef}`);
    await page.getByTestId("reminder-action-reschedule").click();
    const later = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await page.getByTestId("reschedule-input").fill(later.toISOString().slice(0, 16));
    await page.getByTestId("reschedule-confirm").click();
    // The inline reschedule form closes on success (setRescheduling(false) in
    // ReminderLifecycleActions.tsx) - wait for that before opening Activity, otherwise the events
    // fetch (which only ever runs once, on first tab-open) can race the mutation and cache a stale
    // "Created"-only list.
    await expect(page.getByTestId("reschedule-input")).toHaveCount(0);
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByTestId("reminder-activity-row").filter({ hasText: "Rescheduled" })).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("14: a past-due Reminder is derived DUE at read time, never a stored status", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Due Partner` });
    const past = new Date(Date.now() - 60_000).toISOString();
    const due = await fx.seedReminder({ message: `${TAG} due now`, targetType: "PARTNER", targetRef: partner.partnerRef, recipientUserRef: managerUserRef, reminderAt: past });
    await signInAs(page, "head");
    await page.goto(`/operations/reminders/${due.reminderRef}`);
    await expect(page.getByText("Due", { exact: true }).first()).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("15: dismiss is a valid terminal path", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Dismiss Partner` });
    const reminder = await fx.seedReminder({ message: `${TAG} to dismiss`, targetType: "PARTNER", targetRef: partner.partnerRef, recipientUserRef: managerUserRef, reminderAt: new Date(Date.now() + 86400000).toISOString() });
    await signInAs(page, "head");
    await page.goto(`/operations/reminders/${reminder.reminderRef}`);
    await page.getByTestId("reminder-action-dismiss").click();
    await expect(page.getByText("Dismissed", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("reminder-action-dismiss")).toHaveCount(0);
    expect(errors.errors).toEqual([]);
  });

  test("16: complete and cancel are each a valid path from a fresh Reminder", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    const partner = await fx.finance.seedPartner({ displayName: `${TAG} Complete Partner` });
    const toComplete = await fx.seedReminder({ message: `${TAG} to complete`, targetType: "PARTNER", targetRef: partner.partnerRef, recipientUserRef: managerUserRef, reminderAt: new Date(Date.now() + 86400000).toISOString() });
    await signInAs(page, "head");
    await page.goto(`/operations/reminders/${toComplete.reminderRef}`);
    await page.getByTestId("reminder-action-complete").click();
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();

    const toCancel = await fx.seedReminder({ message: `${TAG} to cancel`, targetType: "PARTNER", targetRef: partner.partnerRef, recipientUserRef: managerUserRef, reminderAt: new Date(Date.now() + 86400000).toISOString() });
    await page.goto(`/operations/reminders/${toCancel.reminderRef}`);
    await page.getByTestId("reminder-action-cancel").click();
    await page.getByTestId("cancel-reason-input").fill("No longer needed.");
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    expect(errors.errors).toEqual([]);
  });
});

// ==========================================================================================
for (const width of VIEWPORTS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width >= 1200 ? 900 : 844 } });

    test(`17/18: Tasks, Approval Queue, Reminders - no document-level horizontal overflow`, async ({ page }) => {
      const errors = collectBrowserErrors(page);
      await signInAs(page, "head");

      await page.goto("/operations");
      await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
      await waitForHydration(page, 'input[aria-label="Search tasks"]');
      await expectNoOverflow(page, `Tasks workspace ${width}`);
      // The default filter may or may not show a matching task at this point in the serial suite
      // (several fixture tasks are terminal-status by now) - assert real content rendered (table,
      // cards, or the genuine empty state), not that data exists, regardless of width.
      await expect(page.getByRole("table").or(page.getByTestId("task-card")).or(page.getByText("No tasks match")).first()).toBeVisible();

      await page.goto("/operations/approvals");
      await expect(page.getByRole("heading", { level: 1, name: "Approval Queue" })).toBeVisible();
      await expectNoOverflow(page, `Approval Queue ${width}`);

      await page.goto("/operations/reminders");
      await expect(page.getByRole("heading", { level: 1, name: "Reminders" })).toBeVisible();
      await expectNoOverflow(page, `Reminders workspace ${width}`);

      await page.goto(`/operations/tasks/${lifecycleTaskRef}`);
      await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
      await expectNoOverflow(page, `Task detail ${width}`);

      // 19: zero console errors at every width.
      expect(errors.errors).toEqual([]);
    });
  });
}
