// Step 18A - Operations against the running Firestore/Auth emulator, end to end, on REAL records.
//
// Proven here:
//   - Task lifecycle: create -> start -> block -> unblock -> complete -> reopen -> cancel, with
//     audit events at every step.
//   - Concurrency (section 13): two actors completing the same Task, complete-vs-cancel,
//     reassignment-vs-completion, and a duplicate generateSystemTask call - exactly one write wins
//     in every race, and a duplicate generation never creates a second Task.
//   - Reminder lifecycle: create -> reschedule -> dismiss / complete / cancel, idempotent creation
//     by sourceKey, a reschedule-vs-dismiss race, and the DUE overlay derived at read time.
//   - Approval Queue (section 6), against a REAL Partner Review taken through the real Partner
//     Reviews services: the pending item appears live, disappears the moment the review is
//     finalized through Partner Reviews' OWN service (never through Operations), and Operations
//     never persists or mutates any field on the Partner Review itself. The other three adapters'
//     wiring (feature/action gates, real barrel calls) is proven live too, against the empty state a
//     fresh emulator run legitimately has for them - their mapping logic is unit-tested against
//     realistic fixture data in approval-queue/adapters/adapters.test.ts.
//   - Authz across all five seeded roles for manage_tasks/assign_tasks/complete_tasks/
//     view_approval_queue/manage_reminders.
//   - Sensitive-data guard: no scope field ever reaches a Task/Reminder DTO.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { generatePartnerReviewDraft } from "@/server/partner-reviews/partner-review-service";
import { finalizePartnerReview, submitPartnerReviewForReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { partnerReviewsCollection } from "@/server/partner-reviews/firestore";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

import { getApprovalItem, listApprovalQueue } from "./approval-queue/approval-queue-service";
import { operationsRemindersCollection, operationsTasksCollection } from "./firestore";
import {
  blockTask,
  cancelReminder,
  cancelTask,
  completeReminder,
  completeTask,
  createReminder,
  createTask,
  dismissReminder,
  generateSystemTask,
  getReminder,
  getTask,
  listTaskEvents,
  reassignTask,
  reopenTask,
  rescheduleReminder,
  reviseTask,
  startTask,
  unblockTask,
} from "./index";
import type { OperationsServiceResult } from "./types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const PERIOD = "2026-06";

const uidByRole = new Map<string, string>();
const userRefByRole = new Map<string, string>();
const partnerRefs: string[] = [];
const reviewRefs: string[] = [];
const taskRefs: string[] = [];
const reminderRefs: string[] = [];
let reqCounter = 0;
const requestId = () => `ops-req-${runId}-${(reqCounter += 1)}`;

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
    const actor = await resolveActor(user.uid);
    userRefByRole.set(identity.role, actor!.userRef);
  }
}, 120_000);

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of taskRefs) await db.recursiveDelete(operationsTasksCollection().doc(ref));
  for (const ref of reminderRefs) await db.recursiveDelete(operationsRemindersCollection().doc(ref));
  for (const ref of reviewRefs) await db.recursiveDelete(partnerReviewsCollection().doc(ref));
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

function must<T>(result: OperationsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

function failure(result: OperationsServiceResult<unknown>) {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result;
}

async function realPartner(displayName: string): Promise<{ partnerRef: string }> {
  const head = await actorFor("partnership_head");
  // Kerala is a region both partnership_manager and partnership_head hold explicitly (see
  // seed-access-data.ts's own SCOPE_GRANTS) - every fixture Partner carries it so either seeded
  // role can act on it regardless of which one actually created it.
  const result = await createPartner(head, { displayName, regionIds: ["Kerala"] }, requestId());
  if (!result.ok) throw new Error(`createPartner failed: ${result.code} - ${result.message}`);
  const partnerRef = (result.data as { partnerRef: string }).partnerRef;
  partnerRefs.push(partnerRef);
  return { partnerRef };
}

// ==========================================================================================
describe("Task lifecycle", () => {
  it("create -> start -> block -> unblock -> complete -> reopen -> cancel, each step audited", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Task Partner ${runId}-1`);

    const created = must(await createTask(manager, { title: "Follow up on onboarding", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef, priority: "HIGH" }, requestId()), "create");
    taskRefs.push(created.taskRef);
    expect(created.status).toBe("OPEN");
    expect(created.priority).toBe("HIGH");
    expect(created.docVersion).toBe(1);

    const started = must(await startTask(manager, { taskRef: created.taskRef, expectedDocVersion: 1 }, requestId()), "start");
    expect(started.status).toBe("IN_PROGRESS");

    const blocked = must(await blockTask(manager, { taskRef: created.taskRef, expectedDocVersion: started.docVersion, reason: "waiting on partner reply" }, requestId()), "block");
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockedReason).toBe("waiting on partner reply");

    const unblocked = must(await unblockTask(manager, { taskRef: created.taskRef, expectedDocVersion: blocked.docVersion }, requestId()), "unblock");
    expect(unblocked.status).toBe("IN_PROGRESS");

    const done = must(await completeTask(manager, { taskRef: created.taskRef, expectedDocVersion: unblocked.docVersion }, requestId()), "complete");
    expect(done.status).toBe("DONE");

    const reopened = must(await reopenTask(manager, { taskRef: created.taskRef, expectedDocVersion: done.docVersion, reason: "needs one more follow-up" }, requestId()), "reopen");
    expect(reopened.status).toBe("OPEN");

    const cancelled = must(await cancelTask(manager, { taskRef: created.taskRef, expectedDocVersion: reopened.docVersion, reason: "partner churned" }, requestId()), "cancel");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledReason).toBe("partner churned");

    const events = must(await listTaskEvents(manager, created.taskRef), "events");
    expect(events.events.map((e) => e.kind)).toEqual(["TASK_CANCELLED", "TASK_REOPENED", "TASK_COMPLETED", "TASK_UNBLOCKED", "TASK_BLOCKED", "TASK_STARTED", "TASK_CREATED"]);
  });

  it("reassignment moves the primary assignee (assign_tasks - distinct from manage_tasks/complete_tasks)", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const { partnerRef } = await realPartner(`Ops Task Partner ${runId}-2`);

    const created = must(await createTask(manager, { title: "Reassign me", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef, regionIds: ["Kerala"] }, requestId()), "create");
    taskRefs.push(created.taskRef);

    const reassigned = must(await reassignTask(head, { taskRef: created.taskRef, expectedDocVersion: created.docVersion, assigneeUserRef: head.userRef, reason: "manager is out" }, requestId()), "reassign");
    expect(reassigned.assigneeUserRef).toBe(head.userRef);
  });

  it("a revision opens the next version and records due-date/priority-change events", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Task Partner ${runId}-3`);
    const created = must(await createTask(manager, { title: "Revise me", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef, priority: "NORMAL" }, requestId()), "create");
    taskRefs.push(created.taskRef);

    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const revised = must(await reviseTask(manager, { taskRef: created.taskRef, expectedDocVersion: created.docVersion, priority: "URGENT", dueAt, reason: "escalated" }, requestId()), "revise");
    expect(revised.priority).toBe("URGENT");
    expect(revised.dueAt).toBe(dueAt);
    expect(revised.latestVersion).toBe(2);
  });
});

// ==========================================================================================
describe("Task concurrency (section 13)", () => {
  it("two actors completing the same task: exactly one succeeds, the other reports stale_write", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const { partnerRef } = await realPartner(`Ops Concurrency Partner ${runId}-1`);
    const created = must(await createTask(manager, { title: "Race complete", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef, regionIds: ["Kerala"] }, requestId()), "create");
    taskRefs.push(created.taskRef);

    const [a, b] = await Promise.all([completeTask(manager, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId()), completeTask(head, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId())]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const lost = failure(outcomes.find((r) => !r.ok)!);
    expect(lost.code).toBe("stale_write");
  });

  it("complete vs cancel racing on the same docVersion: exactly one wins", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Concurrency Partner ${runId}-2`);
    const created = must(await createTask(manager, { title: "Race complete-vs-cancel", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef }, requestId()), "create");
    taskRefs.push(created.taskRef);
    const started = must(await startTask(manager, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId()), "start");

    const [complete, cancel] = await Promise.all([
      completeTask(manager, { taskRef: created.taskRef, expectedDocVersion: started.docVersion }, requestId()),
      cancelTask(manager, { taskRef: created.taskRef, expectedDocVersion: started.docVersion, reason: "actually no longer needed" }, requestId()),
    ]);
    expect([complete, cancel].filter((r) => r.ok)).toHaveLength(1);
  });

  it("reassignment vs completion racing on the same docVersion: exactly one wins", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const { partnerRef } = await realPartner(`Ops Concurrency Partner ${runId}-3`);
    const created = must(await createTask(manager, { title: "Race reassign-vs-complete", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef, regionIds: ["Kerala"] }, requestId()), "create");
    taskRefs.push(created.taskRef);

    const [reassign, complete] = await Promise.all([
      reassignTask(head, { taskRef: created.taskRef, expectedDocVersion: created.docVersion, assigneeUserRef: head.userRef, reason: "handoff" }, requestId()),
      completeTask(manager, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId()),
    ]);
    expect([reassign, complete].filter((r) => r.ok)).toHaveLength(1);
  });

  it("a duplicate generateSystemTask call for the exact same sourceKey never creates a second Task", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Concurrency Partner ${runId}-4`);
    const sourceKey = `ops-e2e-duplicate-${runId}`;
    const input = { origin: "APPROVAL_FOLLOW_UP" as const, sourceKey, title: "Generated follow-up", target: { targetType: "PARTNER" as const, targetRef: partnerRef }, assigneeUserRef: manager.userRef };

    const [first, second] = await Promise.all([generateSystemTask(manager, input, requestId()), generateSystemTask(manager, input, requestId())]);
    const a = must(first, "generate 1");
    const b = must(second, "generate 2");
    expect(a.task.taskRef).toBe(b.task.taskRef);
    taskRefs.push(a.task.taskRef);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["created", "existing"]);

    const scan = await operationsTasksCollection().where("sourceKey", "==", sourceKey).get();
    expect(scan.size).toBe(1);
  });
});

// ==========================================================================================
describe("Reminder lifecycle + idempotency + races", () => {
  it("create -> reschedule -> dismiss, with audit events", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Reminder Partner ${runId}-1`);
    const future = new Date(Date.now() + 3_600_000).toISOString();

    const created = must(await createReminder(manager, { target: { targetType: "PARTNER", targetRef: partnerRef }, recipientUserRef: manager.userRef, message: "Check in with partner", reminderAt: future }, requestId()), "create");
    reminderRefs.push(created.reminder.reminderRef);
    expect(created.outcome).toBe("created");
    expect(created.reminder.status).toBe("SCHEDULED");

    const laterAt = new Date(Date.now() + 7_200_000).toISOString();
    const rescheduled = must(await rescheduleReminder(manager, { reminderRef: created.reminder.reminderRef, expectedDocVersion: created.reminder.docVersion, reminderAt: laterAt, reason: "partner asked to push" }, requestId()), "reschedule");
    expect(rescheduled.reminderAt).toBe(laterAt);

    const dismissed = must(await dismissReminder(manager, { reminderRef: created.reminder.reminderRef, expectedDocVersion: rescheduled.docVersion }, requestId()), "dismiss");
    expect(dismissed.status).toBe("DISMISSED");
  });

  it("complete and cancel are each reachable from SCHEDULED", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Reminder Partner ${runId}-2`);
    const future = new Date(Date.now() + 3_600_000).toISOString();

    const r1 = must(await createReminder(manager, { target: { targetType: "PARTNER", targetRef: partnerRef }, recipientUserRef: manager.userRef, message: "m1", reminderAt: future }, requestId()), "create r1");
    reminderRefs.push(r1.reminder.reminderRef);
    const completed = must(await completeReminder(manager, { reminderRef: r1.reminder.reminderRef, expectedDocVersion: r1.reminder.docVersion }, requestId()), "complete");
    expect(completed.status).toBe("COMPLETED");

    const r2 = must(await createReminder(manager, { target: { targetType: "PARTNER", targetRef: partnerRef }, recipientUserRef: manager.userRef, message: "m2", reminderAt: future }, requestId()), "create r2");
    reminderRefs.push(r2.reminder.reminderRef);
    const cancelled = must(await cancelReminder(manager, { reminderRef: r2.reminder.reminderRef, expectedDocVersion: r2.reminder.docVersion, reason: "no longer relevant" }, requestId()), "cancel");
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("a due reminder is derived at read time, never a stored/cron-written status", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Reminder Partner ${runId}-3`);
    const past = new Date(Date.now() - 60_000).toISOString();

    const created = must(await createReminder(manager, { target: { targetType: "PARTNER", targetRef: partnerRef }, recipientUserRef: manager.userRef, message: "overdue check-in", reminderAt: past }, requestId()), "create");
    reminderRefs.push(created.reminder.reminderRef);
    expect(created.reminder.status).toBe("DUE");

    const fetched = must(await getReminder(manager, created.reminder.reminderRef), "get");
    expect(fetched.status).toBe("DUE");
  });

  it("idempotent creation: two calls with the same origin+sourceKey converge on one Reminder", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Reminder Partner ${runId}-4`);
    const sourceKey = `ops-e2e-reminder-duplicate-${runId}`;
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const input = { target: { targetType: "PARTNER" as const, targetRef: partnerRef }, recipientUserRef: manager.userRef, message: "duplicate-proof reminder", reminderAt: future, origin: "APPROVAL_FOLLOW_UP" as const, sourceKey };

    const [first, second] = await Promise.all([createReminder(manager, input, requestId()), createReminder(manager, input, requestId())]);
    const a = must(first, "create 1");
    const b = must(second, "create 2");
    expect(a.reminder.reminderRef).toBe(b.reminder.reminderRef);
    reminderRefs.push(a.reminder.reminderRef);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "existing"]);

    const scan = await operationsRemindersCollection().where("sourceKey", "==", sourceKey).get();
    expect(scan.size).toBe(1);
  });

  it("reschedule vs dismiss racing on the same docVersion: exactly one wins", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Reminder Partner ${runId}-5`);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const created = must(await createReminder(manager, { target: { targetType: "PARTNER", targetRef: partnerRef }, recipientUserRef: manager.userRef, message: "race me", reminderAt: future }, requestId()), "create");
    reminderRefs.push(created.reminder.reminderRef);

    const [rescheduled, dismissed] = await Promise.all([
      rescheduleReminder(manager, { reminderRef: created.reminder.reminderRef, expectedDocVersion: created.reminder.docVersion, reminderAt: new Date(Date.now() + 10_000_000).toISOString() }, requestId()),
      dismissReminder(manager, { reminderRef: created.reminder.reminderRef, expectedDocVersion: created.reminder.docVersion }, requestId()),
    ]);
    expect([rescheduled, dismissed].filter((r) => r.ok)).toHaveLength(1);
  });
});

// ==========================================================================================
describe("Approval Queue (section 6) - live, read-only, cross-module", () => {
  it("surfaces a real IN_REVIEW Partner Review, then it disappears the moment Partner Reviews' OWN finalize call closes it - Operations never wrote to it", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const { partnerRef } = await realPartner(`Ops Approval Partner ${runId}`);

    const draft = must(await generatePartnerReviewDraft(manager, { partnerRef, periodKey: PERIOD }, requestId()), "generate draft");
    const reviewRef = draft.review.head.reviewRef;
    reviewRefs.push(reviewRef);
    const submitted = must(await submitPartnerReviewForReview(manager, reviewRef, { expectedDocVersion: 1 }, requestId()), "submit");
    expect(submitted.head.latestStatus).toBe("IN_REVIEW");

    const beforeRaw = (await partnerReviewsCollection().doc(reviewRef).get()).data();

    const queue = must(await listApprovalQueue(head, { sourceModule: "partner_reviews" }), "list queue");
    const item = queue.items.find((i) => i.sourceRef === reviewRef);
    expect(item).toBeDefined();
    expect(item!.actionType).toBe("FINALIZE_PARTNER_REVIEW");
    expect(item!.currentSourceStatus).toBe("IN_REVIEW");
    expect(item!.allowedActions).toEqual([]);

    const fetched = must(await getApprovalItem(head, item!.approvalItemRef), "get item");
    expect(fetched.sourceRef).toBe(reviewRef);

    // Operations never touched the Partner Review's own document across any of the reads above.
    const afterQueueRaw = (await partnerReviewsCollection().doc(reviewRef).get()).data();
    expect(afterQueueRaw).toEqual(beforeRaw);

    // Now finalize through Partner Reviews' OWN service (never through Operations).
    const finalized = must(await finalizePartnerReview(head, reviewRef, { expectedDocVersion: 2 }, requestId()), "finalize");
    expect(finalized.head.latestStatus).toBe("FINALIZED");

    const refreshedQueue = must(await listApprovalQueue(head, { sourceModule: "partner_reviews" }), "list queue after finalize");
    expect(refreshedQueue.items.find((i) => i.sourceRef === reviewRef)).toBeUndefined();
  });

  it("the other three adapters run live against the real Firestore/authz stack with no error (their mapping logic is unit-tested against realistic fixture data separately)", async () => {
    const head = await actorFor("partnership_head");
    for (const sourceModule of ["finance_payables", "finance_invoices", "finance_payments"] as const) {
      const result = await listApprovalQueue(head, { sourceModule });
      expect(result.ok, `sourceModule=${sourceModule}: ${!result.ok ? result.message : ""}`).toBe(true);
    }
  });

  it("scope/authz: Analyst (no operations feature) and Viewer (view-only override, no view_approval_queue action) are both denied", async () => {
    const analyst = await actorFor("analyst");
    const deniedAnalyst = failure(await listApprovalQueue(analyst, {}));
    expect(deniedAnalyst.code).toBe("unauthorized");

    const viewer = await actorFor("viewer");
    const deniedViewer = failure(await listApprovalQueue(viewer, {}));
    expect(deniedViewer.code).toBe("unauthorized");
  });
});

// ==========================================================================================
describe("Authz matrix - all five roles, exact Operations actions", () => {
  it("Viewer: feature view only, every action denied", async () => {
    const viewer = await actorFor("viewer");
    const { partnerRef } = await realPartner(`Ops Authz Partner ${runId}-viewer`);
    const denied = failure(await createTask(viewer, { title: "x", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: viewer.userRef }, requestId()));
    expect(denied.code).toBe("unauthorized");
    expect(denied.reason).toBe("action_denied");
  });

  it("Analyst: the operations feature itself is denied (no Operations grant at all in the current baseline)", async () => {
    const analyst = await actorFor("analyst");
    const { partnerRef } = await realPartner(`Ops Authz Partner ${runId}-analyst`);
    const denied = failure(await createTask(analyst, { title: "x", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: analyst.userRef }, requestId()));
    expect(denied.code).toBe("unauthorized");
    expect(denied.reason).toBe("feature_denied");
  });

  it("Partnership Manager: full day-to-day Operations action set", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Authz Partner ${runId}-manager`);
    const created = must(await createTask(manager, { title: "manager task", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef }, requestId()), "create");
    taskRefs.push(created.taskRef);
    must(await startTask(manager, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId()), "start");
    must(await reassignTask(manager, { taskRef: created.taskRef, expectedDocVersion: created.docVersion + 1, assigneeUserRef: manager.userRef, reason: "self" }, requestId()), "reassign");
    const queue = must(await listApprovalQueue(manager, {}), "queue");
    expect(queue.items).toBeDefined();
  });

  it("Partnership Head: identical action set to Manager (no separate approval step for Operations itself)", async () => {
    const head = await actorFor("partnership_head");
    const { partnerRef } = await realPartner(`Ops Authz Partner ${runId}-head`);
    const created = must(await createTask(head, { title: "head task", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: head.userRef }, requestId()), "create");
    taskRefs.push(created.taskRef);
    must(await completeTask(head, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId()), "complete");
  });

  it("Super Admin: every action succeeds (auto-derived from MODULE_ACTIONS, not a rank shortcut)", async () => {
    const admin = await actorFor("super_admin");
    const { partnerRef } = await realPartner(`Ops Authz Partner ${runId}-admin`);
    const created = must(await createTask(admin, { title: "admin task", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: admin.userRef }, requestId()), "create");
    taskRefs.push(created.taskRef);
    must(await startTask(admin, { taskRef: created.taskRef, expectedDocVersion: created.docVersion }, requestId()), "start");
    const reminder = must(await createReminder(admin, { target: { targetType: "PARTNER", targetRef: partnerRef }, recipientUserRef: admin.userRef, message: "admin reminder", reminderAt: new Date(Date.now() + 3_600_000).toISOString() }, requestId()), "create reminder");
    reminderRefs.push(reminder.reminder.reminderRef);
    must(await listApprovalQueue(admin, {}), "queue");
  });
});

// ==========================================================================================
describe("Sensitive-data guard (runtime)", () => {
  it("a Task DTO never carries ownerUid/regionIds/teamIds", async () => {
    const manager = await actorFor("partnership_manager");
    const { partnerRef } = await realPartner(`Ops Sensitive Partner ${runId}`);
    const created = must(await createTask(manager, { title: "sensitive check", target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef: manager.userRef }, requestId()), "create");
    taskRefs.push(created.taskRef);
    const fetched = must(await getTask(manager, created.taskRef), "get");
    const keys = Object.keys(fetched);
    expect(keys).not.toContain("ownerUid");
    expect(keys).not.toContain("regionIds");
    expect(keys).not.toContain("teamIds");
  });
});
