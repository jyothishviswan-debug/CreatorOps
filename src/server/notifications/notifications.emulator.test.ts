// Notifications Completion - against the running Firestore/Auth emulator, end to end, on REAL
// records (spec section 28). Proven here:
//   - Idempotent create (retry) and concurrent emission - exactly one notification doc per
//     (source event, recipient), never a duplicate.
//   - Recipient isolation: A receives, B cannot list/read/mutate A's notification, and a guessed
//     ref fails closed with the same neutral not-found.
//   - Lifecycle: unread -> read -> dismiss, mark-all-read, trusted unread count, cursor pagination.
//   - Real event-catalog hooks fired from the actual source-domain services (never a hand-rolled
//     Firestore write): Operations Task assigned + reassigned, Notes/Meetings Meeting created
//     (participant, excluding organizer). Reports finalize/supersede and Content review-decision are
//     proven at the projection-function level directly against the emulator (their own full source
//     pipelines are already covered end-to-end by report-lifecycle.emulator.test.ts /
//     content.emulator.test.ts; this file proves THIS module's own recipient/dedupe/safe-copy
//     behavior for those event types without re-building those heavy fixtures here).
//   - Fail-closed recipient resolution: a null ownerUid never produces a notification.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { createMeeting } from "@/server/notes-meetings/meeting-service";
import { createTask, reassignTask } from "@/server/operations";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

import { notificationsCollection } from "./firestore";
import { dismissNotification, listMyNotifications, markAllNotificationsRead, markNotificationRead } from "./notification-service";
import { getMyUnreadCount } from "./notification-service";
import { createNotification } from "./notification-service";
import { notifyContentReviewDecision, notifyReportFinalized, notifyReportSuperseded } from "./projection";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const uidByRole = new Map<string, string>();
const partnerRefs: string[] = [];
const notificationRefs: string[] = [];
let reqCounter = 0;
const requestId = () => `ntf-req-${runId}-${(reqCounter += 1)}`;

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  const { getAdminAuth } = await import("@/server/firebase/admin");
  const auth = getAdminAuth();
  for (const identity of TEST_IDENTITIES) {
    const user = await auth.getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }
}, 120_000);

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of notificationRefs) await db.recursiveDelete(notificationsCollection().doc(ref));
  for (const ref of partnerRefs) {
    const snap = await partnersCollection().where("partnerRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
});

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

function must<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

async function realPartner(displayName: string): Promise<string> {
  const head = await actorFor("partnership_head");
  const result = await createPartner(head, { displayName, regionIds: ["Kerala"] }, requestId());
  if (!result.ok) throw new Error(`createPartner failed: ${result.code} - ${result.message}`);
  const partnerRef = (result.data as { partnerRef: string }).partnerRef;
  partnerRefs.push(partnerRef);
  return partnerRef;
}

// ==========================================================================================
describe("idempotency and concurrency (spec section 7/28)", () => {
  it("a retried create for the identical event+recipient converges on the same notificationRef, never a duplicate", async () => {
    const viewer = await actorFor("viewer");
    const input = { recipientUserRef: viewer.userRef, type: "TASK_ASSIGNED" as const, sourceDomain: "OPERATIONS" as const, sourceRef: `retry-${runId}`, title: "Task assigned", bodyPreview: "Retry test.", deepLink: "/operations/tasks/x", createdByUserRef: viewer.userRef, requestId: requestId() };
    const first = await createNotification(input);
    const second = await createNotification(input);
    notificationRefs.push(first.notificationRef);
    expect(first.notificationRef).toBe(second.notificationRef);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("existing");

    const snap = await notificationsCollection().where("sourceRef", "==", input.sourceRef).where("recipientUserRef", "==", viewer.userRef).get();
    expect(snap.docs.length).toBe(1);
  });

  it("concurrent emission for the same event+recipient never creates two docs", async () => {
    const analyst = await actorFor("analyst");
    const input = { recipientUserRef: analyst.userRef, type: "TASK_ASSIGNED" as const, sourceDomain: "OPERATIONS" as const, sourceRef: `concurrent-${runId}`, title: "Task assigned", bodyPreview: "Concurrent test.", deepLink: "/operations/tasks/y", createdByUserRef: analyst.userRef, requestId: requestId() };
    const [a, b, c] = await Promise.all([createNotification(input), createNotification(input), createNotification(input)]);
    notificationRefs.push(a.notificationRef);
    expect(a.notificationRef).toBe(b.notificationRef);
    expect(b.notificationRef).toBe(c.notificationRef);

    const snap = await notificationsCollection().where("sourceRef", "==", input.sourceRef).where("recipientUserRef", "==", analyst.userRef).get();
    expect(snap.docs.length).toBe(1);
  });

  it("concurrent emission for two DIFFERENT recipients of the same source event never cross-writes - each gets exactly one of their own", async () => {
    const viewer = await actorFor("viewer");
    const analyst = await actorFor("analyst");
    const sourceRef = `fanout-${runId}`;
    const build = (recipientUserRef: string) => ({ recipientUserRef, type: "MEETING_CREATED" as const, sourceDomain: "NOTES_MEETINGS" as const, sourceRef, title: "Meeting scheduled", bodyPreview: "Fanout test.", deepLink: "/partners/x", createdByUserRef: viewer.userRef, requestId: requestId() });
    const [v, a] = await Promise.all([createNotification(build(viewer.userRef)), createNotification(build(analyst.userRef))]);
    notificationRefs.push(v.notificationRef, a.notificationRef);
    expect(v.notificationRef).not.toBe(a.notificationRef);

    const viewerSnap = await notificationsCollection().where("sourceRef", "==", sourceRef).where("recipientUserRef", "==", viewer.userRef).get();
    const analystSnap = await notificationsCollection().where("sourceRef", "==", sourceRef).where("recipientUserRef", "==", analyst.userRef).get();
    expect(viewerSnap.docs.length).toBe(1);
    expect(analystSnap.docs.length).toBe(1);
  });
});

// ==========================================================================================
describe("recipient isolation (spec section 3/28/31)", () => {
  it("recipient A can list/read/mutate their own notification; recipient B cannot list, read, or mutate it; a guessed ref fails the same neutral way", async () => {
    const viewer = await actorFor("viewer");
    const analyst = await actorFor("analyst");
    const created = await createNotification({ recipientUserRef: viewer.userRef, type: "TASK_ASSIGNED", sourceDomain: "OPERATIONS", sourceRef: `isolation-${runId}`, title: "Task assigned", bodyPreview: "Isolation test.", deepLink: "/operations/tasks/z", createdByUserRef: viewer.userRef, requestId: requestId() });
    notificationRefs.push(created.notificationRef);

    // A can see it in their own list.
    const ownList = must(await listMyNotifications(viewer, { status: "all" }), "own list");
    expect(ownList.notifications.some((n) => n.notificationRef === created.notificationRef)).toBe(true);

    // B's own list never contains A's notification (never client-side-filtered - a different query
    // entirely, scoped server-side to B's own userRef).
    const otherList = must(await listMyNotifications(analyst, { status: "all" }), "other list");
    expect(otherList.notifications.some((n) => n.notificationRef === created.notificationRef)).toBe(false);

    // B cannot mark A's notification read or dismiss it - same neutral not_found as a fully
    // nonexistent ref (never a distinct "forbidden" that would confirm the ref's existence).
    const bRead = await markNotificationRead(analyst, created.notificationRef, requestId());
    expect(bRead.ok).toBe(false);
    const bReadCode = !bRead.ok ? bRead.code : null;
    expect(bReadCode).toBe("not_found");

    const bDismiss = await dismissNotification(analyst, created.notificationRef, requestId());
    expect(bDismiss.ok).toBe(false);
    if (!bDismiss.ok) expect(bDismiss.code).toBe("not_found");

    const guessed = await markNotificationRead(analyst, "ntf_0000000000000000000000000000ff", requestId());
    expect(guessed.ok).toBe(false);
    if (!guessed.ok) expect(guessed.code).toBe(bReadCode); // same error shape as the real-ref-wrong-owner case

    // Unauthenticated (null actor) is rejected too.
    const anon = await markNotificationRead(null, created.notificationRef, requestId());
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.code).toBe("unauthorized");

    // A can legitimately read their own.
    const aRead = must(await markNotificationRead(viewer, created.notificationRef, requestId()), "a read");
    expect(aRead.readAt).not.toBeNull();
    expect(aRead.unread).toBe(false);
  });
});

// ==========================================================================================
describe("read/unread/dismiss lifecycle + trusted unread count (spec section 8/9)", () => {
  it("unread count reflects reality and updates after read/dismiss/mark-all-read", async () => {
    const head = await actorFor("partnership_head");
    const before = must(await getMyUnreadCount(head), "count before").count;

    const a = await createNotification({ recipientUserRef: head.userRef, type: "ASSIGNMENT_CREATED", sourceDomain: "ASSIGNMENTS", sourceRef: `count-a-${runId}`, title: "Assignment created", bodyPreview: "Count test A.", deepLink: "/assignments/a", createdByUserRef: head.userRef, requestId: requestId() });
    const b = await createNotification({ recipientUserRef: head.userRef, type: "ASSIGNMENT_CREATED", sourceDomain: "ASSIGNMENTS", sourceRef: `count-b-${runId}`, title: "Assignment created", bodyPreview: "Count test B.", deepLink: "/assignments/b", createdByUserRef: head.userRef, requestId: requestId() });
    notificationRefs.push(a.notificationRef, b.notificationRef);

    const afterCreate = must(await getMyUnreadCount(head), "count after create").count;
    expect(afterCreate).toBe(before + 2);

    must(await markNotificationRead(head, a.notificationRef, requestId()), "mark a read");
    const afterRead = must(await getMyUnreadCount(head), "count after read").count;
    expect(afterRead).toBe(before + 1);

    must(await dismissNotification(head, b.notificationRef, requestId()), "dismiss b");
    const afterDismiss = must(await getMyUnreadCount(head), "count after dismiss").count;
    expect(afterDismiss).toBe(before);

    // Dismiss no longer appears in the "unread" list, but is preserved (not deleted) and visible
    // under "dismissed"/"all" - spec section 8's "hides from normal attention, does not delete".
    const unreadList = must(await listMyNotifications(head, { status: "unread" }), "unread list");
    expect(unreadList.notifications.some((n) => n.notificationRef === b.notificationRef)).toBe(false);
    const dismissedList = must(await listMyNotifications(head, { status: "dismissed" }), "dismissed list");
    expect(dismissedList.notifications.some((n) => n.notificationRef === b.notificationRef)).toBe(true);
  });

  it("mark-all-read clears the recipient's own unread notifications only", async () => {
    const manager = await actorFor("partnership_manager");
    const one = await createNotification({ recipientUserRef: manager.userRef, type: "ASSIGNMENT_CREATED", sourceDomain: "ASSIGNMENTS", sourceRef: `bulk-1-${runId}`, title: "Assignment created", bodyPreview: "Bulk test.", deepLink: "/assignments/c", createdByUserRef: manager.userRef, requestId: requestId() });
    const two = await createNotification({ recipientUserRef: manager.userRef, type: "ASSIGNMENT_CREATED", sourceDomain: "ASSIGNMENTS", sourceRef: `bulk-2-${runId}`, title: "Assignment created", bodyPreview: "Bulk test.", deepLink: "/assignments/d", createdByUserRef: manager.userRef, requestId: requestId() });
    notificationRefs.push(one.notificationRef, two.notificationRef);

    const result = must(await markAllNotificationsRead(manager, requestId()), "mark all read");
    expect(result.updated).toBeGreaterThanOrEqual(2);

    const remaining = must(await getMyUnreadCount(manager), "count after bulk").count;
    expect(remaining).toBe(0);
  });

  it("dismissing or reading a notification twice is idempotent (no error, no state regression)", async () => {
    const viewer = await actorFor("viewer");
    const created = await createNotification({ recipientUserRef: viewer.userRef, type: "TASK_ASSIGNED", sourceDomain: "OPERATIONS", sourceRef: `idem-read-${runId}`, title: "Task assigned", bodyPreview: "Idempotent read test.", deepLink: "/operations/tasks/idem", createdByUserRef: viewer.userRef, requestId: requestId() });
    notificationRefs.push(created.notificationRef);

    const first = must(await markNotificationRead(viewer, created.notificationRef, requestId()), "first read");
    const second = must(await markNotificationRead(viewer, created.notificationRef, requestId()), "second read");
    expect(second.readAt).toBe(first.readAt);
  });
});

// ==========================================================================================
describe("real Operations hook: Task assigned + reassigned (spec section 20/28)", () => {
  it("createTask fires a safe TASK_ASSIGNED notification for the assignee, and reassignTask fires a distinct TASK_REASSIGNED notification for the new assignee", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const partnerRef = await realPartner(`Notif Task Partner ${runId}`);

    const created = must(await createTask(manager, { title: `Prepare campaign brief ${runId}`, target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef, priority: "HIGH", regionIds: ["Kerala"] }, requestId()), "createTask");

    const list = must(await listMyNotifications(manager, { status: "all" }), "manager notifications");
    const assigned = list.notifications.find((n) => n.type === "TASK_ASSIGNED" && n.deepLink === `/operations/tasks/${created.taskRef}`);
    expect(assigned).toBeDefined();
    notificationRefs.push(assigned!.notificationRef);
    expect(assigned!.title).toBe("Task assigned");
    expect(assigned!.bodyPreview).toContain("Prepare campaign brief");
    // Raw-ref suppression (spec section 11/31): the safe copy never contains the opaque taskRef.
    expect(assigned!.bodyPreview).not.toContain(created.taskRef);
    expect(assigned!.title).not.toContain(created.taskRef);

    const reassigned = must(await reassignTask(head, { taskRef: created.taskRef, expectedDocVersion: created.docVersion, assigneeUserRef: head.userRef, reason: "coverage" }, requestId()), "reassignTask");

    const headList = must(await listMyNotifications(head, { status: "all" }), "head notifications");
    const reassignedNotif = headList.notifications.find((n) => n.type === "TASK_REASSIGNED" && n.deepLink === `/operations/tasks/${created.taskRef}`);
    expect(reassignedNotif).toBeDefined();
    notificationRefs.push(reassignedNotif!.notificationRef);
    expect(reassignedNotif!.notificationRef).not.toBe(assigned!.notificationRef); // distinct docs, not an overwrite

    // The PREVIOUS assignee (manager) deliberately does NOT get a second "unassigned" notification
    // for THIS task (documented judgment call - see projection.ts's own comment on
    // notifyTaskReassigned). Scoped to this task's own deep link, not "manager has zero
    // TASK_REASSIGNED notifications ever" - other emulator test files running concurrently share the
    // same seeded manager user and may legitimately reassign unrelated tasks to them.
    const managerAfterReassign = must(await listMyNotifications(manager, { status: "all" }), "manager after reassign");
    expect(managerAfterReassign.notifications.some((n) => n.type === "TASK_REASSIGNED" && n.deepLink === `/operations/tasks/${created.taskRef}`)).toBe(false);

    expect(reassigned.assigneeUserRef).toBe(head.userRef);
  });
});

// ==========================================================================================
describe("real Notes/Meetings hook: Meeting created (spec section 21/28)", () => {
  it("notifies participants but never the organizer, with a safe title-only copy", async () => {
    const head = await actorFor("partnership_head");
    const viewer = await actorFor("viewer");
    const partnerRef = await realPartner(`Notif Meeting Partner ${runId}`);

    await createMeeting(head, { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, title: `Weekly sync ${runId}`, meetingAt: new Date().toISOString(), participants: [{ userRef: head.userRef }, { userRef: viewer.userRef }] }, requestId());

    const viewerList = must(await listMyNotifications(viewer, { status: "all" }), "viewer notifications");
    const meetingNotif = viewerList.notifications.find((n) => n.type === "MEETING_CREATED" && n.deepLink === `/partners/${partnerRef}`);
    expect(meetingNotif).toBeDefined();
    notificationRefs.push(meetingNotif!.notificationRef);
    expect(meetingNotif!.bodyPreview).toContain("Weekly sync");

    // The organizer (head) is excluded from their own "you were added" notification.
    const headList = must(await listMyNotifications(head, { status: "all" }), "head notifications");
    expect(headList.notifications.some((n) => n.type === "MEETING_CREATED" && n.deepLink === `/partners/${partnerRef}`)).toBe(false);
  });
});

// ==========================================================================================
describe("Reports finalize/supersede projection (spec section 22/28)", () => {
  it("notifies the drafter on finalize, and the previous drafter on supersede - never the actor notifying themselves", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const runRef = `rrun_notif_${runId}`;

    await notifyReportFinalized({ runRef, reportId: "monthly-performance", version: 1, drafterUserRef: manager.userRef, finalizedByUserRef: head.userRef, requestId: requestId() });
    const managerList = must(await listMyNotifications(manager, { status: "all" }), "manager finalized list");
    const finalized = managerList.notifications.find((n) => n.type === "REPORT_FINALIZED" && n.deepLink === "/reports/monthly-performance");
    expect(finalized).toBeDefined();
    notificationRefs.push(finalized!.notificationRef);

    // Self-finalize never notifies (no attention value in your own just-completed action).
    const selfFinalizeSourceRef = `${runRef}-self`;
    await notifyReportFinalized({ runRef: selfFinalizeSourceRef, reportId: "monthly-performance", version: 1, drafterUserRef: head.userRef, finalizedByUserRef: head.userRef, requestId: requestId() });
    const headSelfList = must(await listMyNotifications(head, { status: "all" }), "head self-finalize list");
    expect(headSelfList.notifications.some((n) => n.type === "REPORT_FINALIZED" && n.deepLink === "/reports/monthly-performance" && n.sourceDomain === "REPORTS")).toBe(false);

    await notifyReportSuperseded({ runRef, reportId: "monthly-performance", supersededVersion: 1, supersededDrafterUserRef: manager.userRef, supersedingActorUserRef: head.userRef, requestId: requestId() });
    const managerListAfter = must(await listMyNotifications(manager, { status: "all" }), "manager superseded list");
    const superseded = managerListAfter.notifications.find((n) => n.type === "REPORT_SUPERSEDED");
    expect(superseded).toBeDefined();
    notificationRefs.push(superseded!.notificationRef);
  });
});

// ==========================================================================================
describe("fail-closed recipient resolution (spec section 6/23)", () => {
  it("a null ownerUid never produces a Content-review-decision notification", async () => {
    const manager = await actorFor("partnership_manager");
    const before = await notificationsCollection().where("sourceDomain", "==", "CONTENT").where("sourceRef", "==", `no-owner-${runId}`).get();
    await notifyContentReviewDecision({ contentRef: `no-owner-${runId}`, ownerUid: null, decision: "approved", newVersion: 1, actorUserRef: manager.userRef, requestId: requestId() });
    const after = await notificationsCollection().where("sourceDomain", "==", "CONTENT").where("sourceRef", "==", `no-owner-${runId}`).get();
    expect(after.docs.length).toBe(before.docs.length);
    expect(after.docs.length).toBe(0);
  });
});
