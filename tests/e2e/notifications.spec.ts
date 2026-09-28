import { expect as baseExpect, test } from "@playwright/test";

import { actorUserRefFor, cleanupNotificationsFor, cleanupTaskAndPartner, collectBrowserErrors, noDocumentOverflow, seedRealTaskAssignedTo, signInAs, VIEWPORTS } from "./helpers/notifications-fixtures";
import { reassignTask } from "@/server/operations";
import { resolveActor } from "@/server/authz/actor";
import { getAdminAuth } from "@/server/firebase/admin";

// Notifications Completion e2e - the real flagship journey through a real browser against the real
// Firestore/Auth emulators. Covers spec section 29: sign in as the recipient, see the unread badge,
// open the panel, inspect safe copy, click through the deep link, see it become read, return, dismiss
// another, unread count updates. Also: empty state, guessed notification ref, source access removed
// after creation, mobile panel, keyboard navigation, mark-all-read.
//
// Trigger mechanism (documented judgment call): the SOURCE EVENT (a real Task assigned) is created
// via a direct call to the real, trusted createTask/reassignTask service functions (see
// tests/e2e/helpers/notifications-fixtures.ts's own header comment) - the exact same idiom this
// codebase's own tests/e2e/notes-meetings.spec.ts uses for its seedRealPartner fixture (a real
// service call, never a mock, for the setup step that isn't itself the feature under test). Nothing
// about the notification bell's own creation, read, dismiss, or unread-count behavior is mocked -
// every assertion below drives the real browser against the real API routes.

const expect = baseExpect.configure({ timeout: 20_000 });

test.describe.configure({ mode: "serial" });

let viewerUserRef: string;
const seededTaskRefs: { taskRef: string; partnerRef: string }[] = [];

test.beforeAll(async () => {
  viewerUserRef = await actorUserRefFor("viewer");
});

test.afterAll(async () => {
  for (const { taskRef, partnerRef } of seededTaskRefs) await cleanupTaskAndPartner(taskRef, partnerRef);
  await cleanupNotificationsFor(viewerUserRef);
});

test.describe("Flagship journey", () => {
  test("1: empty state before anything is seeded", async ({ page }) => {
    await cleanupNotificationsFor(viewerUserRef);
    const errors = collectBrowserErrors(page);
    await signInAs(page, "viewer");
    await page.goto("/dashboard");
    const bell = page.getByRole("button", { name: /Notifications/ });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
    await expect(page.getByText("You're all caught up.")).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("2: a real Task assignment fires a real notification - unread badge, safe copy, deep link, becomes read on click", async ({ page }) => {
    const seeded = await seedRealTaskAssignedTo("viewer", `Prepare campaign brief ${Date.now()}`);
    seededTaskRefs.push(seeded);

    await signInAs(page, "viewer");
    await page.goto("/dashboard");

    const bell = page.getByRole("button", { name: /1 unread/ });
    await expect(bell).toBeVisible();

    await bell.click();
    const panel = page.getByRole("dialog", { name: "Notifications" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Task assigned")).toBeVisible();
    await expect(panel.getByText(/Unread/)).toBeVisible();
    // Safe copy: the raw opaque taskRef never appears anywhere in the panel.
    const panelText = await panel.innerText();
    expect(panelText).not.toContain(seeded.taskRef);

    await panel.getByText("Task assigned").click();
    await expect(page).toHaveURL(new RegExp(`/operations/tasks/${seeded.taskRef}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Back on the dashboard, the badge no longer shows this as unread.
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /1 unread/ })).toHaveCount(0);
  });

  test("3: dismiss hides a notification from the panel without deleting it, and unread count updates", async ({ page }) => {
    const seeded = await seedRealTaskAssignedTo("viewer", `Second task ${Date.now()}`);
    seededTaskRefs.push(seeded);

    await signInAs(page, "viewer");
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /1 unread/ })).toBeVisible();

    await page.getByRole("button", { name: /Notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Notifications" });
    const item = panel.locator(".notifitem", { hasText: "Second task" }).first();
    await item.getByRole("button", { name: /Dismiss/ }).click();
    await expect(item).toHaveCount(0);

    await expect(page.getByRole("button", { name: /unread/ })).toHaveCount(0);
  });

  test("4: mark-all-read clears every unread item at once", async ({ page }) => {
    await seedRealTaskAssignedTo("viewer", `Bulk A ${Date.now()}`).then((r) => seededTaskRefs.push(r));
    await seedRealTaskAssignedTo("viewer", `Bulk B ${Date.now()}`).then((r) => seededTaskRefs.push(r));

    await signInAs(page, "viewer");
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /2 unread/ })).toBeVisible();

    await page.getByRole("button", { name: /Notifications/ }).click();
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByRole("button", { name: /unread/ })).toHaveCount(0);
  });

  test("5: a guessed notification ref fails closed via the real API, never leaking existence", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/dashboard");
    const response = await page.request.post("/api/notifications/ntf_0000000000000000000000000000ff/read");
    expect(response.status()).toBe(404);
  });

  test("6: source access removed after creation - the deep link fails safely, never a broken/leaky page", async ({ page }) => {
    // Deliberately no regionIds (spec section 3's "explicit, settable scope" - see
    // operations-gate.ts): viewer's only route to this task is being its assignee, so reassigning it
    // away genuinely removes every scope path back to it (a regional grant would otherwise still let
    // viewer see it, which is not what this test means to prove).
    const seeded = await seedRealTaskAssignedTo("viewer", `Access-removed task ${Date.now()}`, { regionIds: [] });
    seededTaskRefs.push(seeded);

    // Reassign the task away from viewer through the real service - viewer loses assignee scope. The
    // reassignment is performed by "manager" (the task's own createdByUserRef), the one actor who
    // can still see a task with no region/team scope of its own even after the assignee changes.
    const auth = getAdminAuth();
    const managerUser = await auth.getUserByEmail("manager@creatorops.com");
    const headUser = await auth.getUserByEmail("head@creatorops.com");
    const manager = await resolveActor(managerUser.uid);
    const head = await resolveActor(headUser.uid);
    if (!manager || !head) throw new Error("no resolved actor for manager/head");
    const reassignResult = await reassignTask(manager, { taskRef: seeded.taskRef, expectedDocVersion: seeded.docVersion, assigneeUserRef: head.userRef, reason: "e2e scope-removal test" }, `ntf-e2e-reassign-${Date.now()}`);
    if (!reassignResult.ok) throw new Error(`reassign failed: ${reassignResult.code}`);

    await signInAs(page, "viewer");
    // Navigate directly to the (now stale) deep link the original TASK_ASSIGNED notification pointed
    // at - the destination re-runs its own authorization and fails safely, never showing task content.
    await page.goto(`/operations/tasks/${seeded.taskRef}`);
    await expect(page.getByRole("heading", { level: 1, name: "Task not found" })).toBeVisible();
    await expect(page.getByText(`Access-removed task`)).toHaveCount(0);
  });

  test("7: keyboard - Escape closes the panel and returns focus to the bell", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/dashboard");
    const bell = page.getByRole("button", { name: /Notifications/ });
    await bell.click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Notifications" })).toHaveCount(0);
    await expect(bell).toBeFocused();
  });

  test("8: mobile width - the panel becomes a full-height drawer, no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seeded = await seedRealTaskAssignedTo("viewer", `Mobile panel task ${Date.now()}`);
    seededTaskRefs.push(seeded);

    await signInAs(page, "viewer");
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /Notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Notifications" });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.width).toBeGreaterThan(300);

    const overflow = await noDocumentOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  });
});

test.describe("Six-width responsive sweep (spec section 26/30)", () => {
  for (const width of VIEWPORTS) {
    test(`bell renders with no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "viewer");
      await page.goto("/dashboard");
      await expect(page.getByRole("button", { name: /Notifications/ })).toBeVisible();
      const overflow = await noDocumentOverflow(page);
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
    });
  }
});
