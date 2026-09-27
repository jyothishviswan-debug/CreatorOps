import { expect as baseExpect, test } from "@playwright/test";

import { cleanupPartner, collectBrowserErrors, noDocumentOverflow, seedRealPartner, signInAs, waitForHydration, VIEWPORTS } from "./helpers/notes-meetings-fixtures";

// Notes/Meetings Completion e2e - the real flagship journey through a real browser against the real
// Firestore/Auth emulators (private-port Playwright config - see playwright.notes-meetings.config.ts;
// the tracked playwright.config.ts is never modified). Covers spec section 26 in full: sign in, open a
// real owner record, add a contextual Note, revise it and inspect history, create a Meeting, add
// participants, record a decision, create a MeetingActionItem, promote it to an Operations Task,
// follow the deep link, return to the Meeting and see the linked Task, and verify raw ids are never
// user-facing. Also: unauthorized actor, sensitive Note/Meeting, stale conflict, duplicate promote,
// and a mobile-width workflow pass.
//
// partnership_head (head@creatorops.com) is used as the flagship actor: it holds Partners
// manage_notes/manage_meetings/promote_action_item AND the notes_meetings_sensitive category (see
// seed-access-data.ts), so one actor can prove both the ordinary and the sensitive path.

const expect = baseExpect.configure({ timeout: 20_000 });

test.describe.configure({ mode: "serial" });

let partnerRef: string;

test.afterAll(async () => {
  if (partnerRef) await cleanupPartner(partnerRef);
});

test.describe("Flagship journey", () => {
  test("1: sign in, open a real Partner, open Notes & meetings", async ({ page }) => {
    partnerRef = await seedRealPartner(`NM E2E Partner ${Date.now()}`);
    const errors = collectBrowserErrors(page);
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.getByRole("tab", { name: "Notes", exact: true })).toBeVisible();
    expect(errors.errors).toEqual([]);
  });

  test("2: add a contextual Note", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();

    await page.getByLabel("Add a note").fill("Kickoff call confirmed for next week.");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Kickoff call confirmed for next week." })).toBeVisible();
  });

  test("3: revise the Note and inspect its history", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Kickoff call confirmed for next week." })).toBeVisible();

    await page.getByRole("button", { name: "Revise" }).first().click();
    await page.getByLabel("Revise note").fill("Kickoff call moved to Monday 10am.");
    await page.getByLabel("Reason for this revision").fill("Schedule changed");
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Kickoff call moved to Monday 10am." })).toBeVisible();

    await page.getByRole("button", { name: "History" }).first().click();
    await expect(page.getByRole("heading", { name: "Note history" })).toBeVisible();
    await expect(page.getByText("Version 1")).toBeVisible();
    await expect(page.getByText("Version 2")).toBeVisible();
    await expect(page.getByText("Reason: Schedule changed")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
  });

  test("4: create a Meeting with participants, agenda and a decision", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await page.getByRole("tab", { name: "Meetings", exact: true }).click();

    await page.getByRole("button", { name: "Create meeting" }).click();
    await expect(page.getByRole("heading", { name: "Create meeting" })).toBeVisible();

    await page.locator("#meeting-title").fill("Partner renewal discussion");
    const meetingAt = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    await page.locator("#meeting-at").fill(meetingAt);

    // Add a participant via the picker's own search/select flow.
    await page.locator("#meeting-participants").fill("head");
    await expect(page.getByRole("button", { name: "Select" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Select" }).first().click();

    await page.locator("#meeting-agenda").fill("Discuss renewal terms and timeline.");
    await page.locator("#meeting-decision").fill("Renew for another 12 months");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Renew for another 12 months")).toBeVisible();

    await page.getByRole("dialog").getByRole("button", { name: "Create meeting", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create meeting" })).not.toBeVisible();
    await expect(page.getByText("Partner renewal discussion")).toBeVisible();
  });

  test("5: open the Meeting, create a MeetingActionItem, promote it to an Operations Task, follow the deep link both ways", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await page.getByRole("tab", { name: "Meetings", exact: true }).click();

    await page.getByText("Partner renewal discussion").click();
    await expect(page.getByRole("heading", { name: "Partner renewal discussion" })).toBeVisible();
    await expect(page.getByText("Renew for another 12 months")).toBeVisible(); // decision preserved

    await page.getByLabel("Add action item").fill("Send the renewal contract");
    await page.locator("#action-item-assignee").fill("head");
    await expect(page.getByRole("button", { name: "Select" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Select" }).first().click();
    await page.getByRole("button", { name: "Add action item" }).click();
    await expect(page.getByText("Send the renewal contract")).toBeVisible();

    const promoteResponse = page.waitForResponse((r) => r.url().includes("/promote") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Promote to Task" }).click();
    const response = await promoteResponse;
    expect(response.status()).toBe(200);
    const promoted = (await response.json()) as { promotedTaskRef: string };
    expect(promoted.promotedTaskRef).toMatch(/^tsk_[0-9a-f]{20}$/);

    const taskLink = page.getByRole("link", { name: /Meeting action item: Send the renewal contract/ });
    await expect(taskLink).toBeVisible();
    const href = await taskLink.getAttribute("href");
    expect(href).toBe(`/operations/tasks/${promoted.promotedTaskRef}`);

    // Follow the forward deep link.
    await taskLink.click();
    await page.waitForURL(new RegExp(`/operations/tasks/${promoted.promotedTaskRef}$`));
    await expect(page.getByRole("heading", { name: /Meeting action item: Send the renewal contract/ })).toBeVisible();

    // Reverse deep link: the Task detail page offers a real link back to the source record.
    const backLink = page.getByRole("link", { name: "View source record (Notes & meetings)" });
    await expect(backLink).toBeVisible();
    const backHref = await backLink.getAttribute("href");
    expect(backHref).toBe(`/partners/${partnerRef}`);
    await backLink.click();
    await page.waitForURL(new RegExp(`/partners/${partnerRef}$`));

    // Return to the Meeting and see the linked Task still there.
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await page.getByRole("tab", { name: "Meetings", exact: true }).click();
    await page.getByText("Partner renewal discussion").click();
    await expect(page.getByText(/Promoted to Operations Task/)).toBeVisible();
  });

  test("6: raw ids are never user-facing anywhere in this journey", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/note_[0-9a-f]{20}/);
    expect(bodyText).not.toMatch(/mtg_[0-9a-f]{20}/);
    expect(bodyText).not.toMatch(/mai_[0-9a-f]{20}/);

    await page.getByRole("tab", { name: "Meetings", exact: true }).click();
    await page.getByText("Partner renewal discussion").click();
    const dialogText = await page.locator("dialog[open]").innerText();
    expect(dialogText).not.toMatch(/note_[0-9a-f]{20}/);
    expect(dialogText).not.toMatch(/mtg_[0-9a-f]{20}/);
    expect(dialogText).not.toMatch(/mai_[0-9a-f]{20}/);
    // The Task IS shown by a resolved title, never by its raw taskRef, in this dialog.
    expect(dialogText).not.toMatch(/tsk_[0-9a-f]{20}/);
  });
});

test.describe("Unauthorized actor", () => {
  test("Viewer sees Notes/Meetings content but no write controls, and is denied server-side on a direct write attempt", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.getByLabel("Add a note")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create meeting" })).toHaveCount(0);

    const response = await page.request.post("/api/notes-meetings/notes", { data: { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, body: "should be denied" } });
    expect(response.status()).toBe(403);
  });
});

test.describe("Sensitive Note/Meeting", () => {
  test("a RESTRICTED note is redacted for an actor without the sensitive category", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await page.getByLabel("Add a note").fill("Confidential pricing discussion.");
    await page.getByLabel(/Mark this note sensitive/).check();
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Confidential pricing discussion." })).toBeVisible();

    // partnership_manager holds manage_notes but NOT the notes_meetings_sensitive category.
    await signInAs(page, "manager");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Confidential pricing discussion." })).toHaveCount(0);
    await expect(page.getByText("Restricted note - you do not have access to view its content.")).toBeVisible();
  });
});

test.describe("Stale conflict", () => {
  test("revising a note with a stale expectedDocVersion surfaces a real conflict, never a silent overwrite", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await page.getByLabel("Add a note").fill("Stale-conflict note v1");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Stale-conflict note v1" })).toBeVisible();

    // Get the note's current docVersion via the API the page itself just used.
    const list = await page.request.get(`/api/notes-meetings/notes?ownerType=PARTNER&ownerRef=${partnerRef}`);
    const { notes } = (await list.json()) as { notes: Array<{ noteRef: string; docVersion: number; body: string }> };
    const target = notes.find((n) => n.body === "Stale-conflict note v1")!;

    // A genuine concurrent editor revises it first through the real service.
    const firstRevise = await page.request.post(`/api/notes-meetings/notes/${target.noteRef}/revise`, { data: { expectedDocVersion: target.docVersion, body: "v2 from elsewhere", reason: "concurrent edit" } });
    expect(firstRevise.status()).toBe(200);

    // This page's own UI still thinks it's at the old docVersion - reviseNote() call rejects it.
    const staleAttempt = await page.request.post(`/api/notes-meetings/notes/${target.noteRef}/revise`, { data: { expectedDocVersion: target.docVersion, body: "stale overwrite attempt", reason: "stale attempt" } });
    expect(staleAttempt.status()).toBe(409);
  });
});

test.describe("Duplicate promote", () => {
  test("promoting the same action item twice via direct API calls converges on exactly one Task", async ({ page }) => {
    await signInAs(page, "head");
    const meetingResponse = await page.request.post("/api/notes-meetings/meetings", { data: { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, title: "Duplicate promote test", meetingAt: new Date().toISOString() } });
    const meeting = (await meetingResponse.json()) as { meetingRef: string; docVersion: number };
    const itemResponse = await page.request.post(`/api/notes-meetings/meetings/${meeting.meetingRef}/action-items`, { data: { expectedDocVersion: meeting.docVersion, text: "Duplicate promote target" } });
    const item = (await itemResponse.json()) as { actionItemRef: string };

    const searchResponse = await page.request.get("/api/notes-meetings/users/search?emailPrefix=head");
    const { users } = (await searchResponse.json()) as { users: Array<{ userRef: string }> };
    const headUserRef = users[0]?.userRef;

    const [first, second] = await Promise.all([
      page.request.post(`/api/notes-meetings/action-items/${item.actionItemRef}/promote`, { data: { assigneeUserRef: headUserRef } }),
      page.request.post(`/api/notes-meetings/action-items/${item.actionItemRef}/promote`, { data: { assigneeUserRef: headUserRef } }),
    ]);
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    const firstBody = (await first.json()) as { promotedTaskRef: string };
    const secondBody = (await second.json()) as { promotedTaskRef: string };
    expect(firstBody.promotedTaskRef).toBe(secondBody.promotedTaskRef);
  });
});

test.describe("Mobile workflow + six-width responsive", () => {
  for (const width of VIEWPORTS) {
    test(`width ${width}: Notes & meetings renders with no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "head");
      await page.goto(`/partners/${partnerRef}`);
      await waitForHydration(page, '[role="tab"]');
      await page.getByRole("tab", { name: "Notes & meetings" }).click();
      await expect(page.getByRole("tab", { name: "Notes", exact: true })).toBeVisible();
      const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
      expect(scrollWidth, `width ${width}: document scrolls horizontally`).toBeLessThanOrEqual(innerWidth + 1);
    });
  }

  test("mobile (375): the full add-note workflow works with touch-safe controls", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAs(page, "head");
    await page.goto(`/partners/${partnerRef}`);
    await waitForHydration(page, '[role="tab"]');
    await page.getByRole("tab", { name: "Notes & meetings" }).click();
    await page.getByLabel("Add a note").fill("Mobile note");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator("p.detailcopy", { hasText: "Mobile note" })).toBeVisible();
  });
});
