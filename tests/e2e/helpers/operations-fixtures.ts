import { randomUUID } from "node:crypto";

import { createFinanceFixtures, emailFor, PASSWORD, signInAs, VIEWPORTS, type RoleName } from "./finance-agreements-fixtures";
import { createFixtures as createReviewFixtures } from "./partner-reviews-fixtures";

import { createTask } from "@/server/operations/task-service";
import { createReminder } from "@/server/operations/reminder-service";
import { finalizePartnerReview } from "@/server/partner-reviews/partner-review-lifecycle-service";
import { getAdminFirestore } from "@/server/firebase/admin";
import { operationsTasksCollection, operationsRemindersCollection } from "@/server/operations/firestore";
import { getPartnerDocByRef } from "@/server/partners/firestore";
import type { PartnerDoc } from "@/server/partners/types";

// Step 18B e2e fixtures for the Operations UI. Built on TOP of createFinanceFixtures (real Partner
// records + actorOf(role)) and partner-reviews-fixtures' seedDirectReview - the SAME established
// idiom finance-payables-fixtures.ts already uses for the identical reason: a Playwright test
// process is a plain Node process, so Partner Reviews' live commercial-policy DI registration never
// runs in it. seedDirectReview writes a schema-valid Review document directly (no policy required
// for an IN_REVIEW item with no commercial evidence attached), which is exactly what the Approval
// Queue's Partner Reviews adapter needs to find a real, live pending item.
//
// Tasks/Reminders are created through the TRUSTED service layer directly (createTask/createReminder),
// never through the Operations UI itself - same "seed via the real domain function, exercise the UI
// for what's actually under test" discipline as every other Finance e2e fixture in this repo.
export { emailFor, PASSWORD, signInAs, VIEWPORTS };
export type { RoleName };

function must<T>(r: { ok: boolean; data?: T; code?: string; message?: string }, label: string): T {
  if (!r.ok) throw new Error(`${label} failed: ${r.code} ${r.message}`);
  return r.data!;
}

export function createOperationsFixtures(tag: string) {
  const finance = createFinanceFixtures(tag);
  const reviews = createReviewFixtures(tag);
  const taskRefs: string[] = [];
  const reminderRefs: string[] = [];

  async function seedTask(over: { title: string; targetType: "PARTNER" | "PARTNER_REVIEW"; targetRef: string; assigneeUserRef: string; priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT"; as?: RoleName }) {
    const actor = await finance.actorOf(over.as ?? "head");
    const result = must(
      await createTask(actor, { title: over.title, target: { targetType: over.targetType, targetRef: over.targetRef }, assigneeUserRef: over.assigneeUserRef, priority: over.priority ?? "NORMAL" }, randomUUID()),
      "createTask",
    );
    taskRefs.push(result.taskRef);
    return result;
  }

  async function seedReminder(over: { message: string; targetType: "PARTNER" | "PARTNER_REVIEW"; targetRef: string; recipientUserRef: string; reminderAt: string; as?: RoleName }) {
    const actor = await finance.actorOf(over.as ?? "head");
    const result = must(
      await createReminder(actor, { target: { targetType: over.targetType, targetRef: over.targetRef }, recipientUserRef: over.recipientUserRef, message: over.message, reminderAt: over.reminderAt }, randomUUID()),
      "createReminder",
    );
    reminderRefs.push(result.reminder.reminderRef);
    return result.reminder;
  }

  // A real, live IN_REVIEW Partner Review the Approval Queue's own Partner Reviews adapter can find -
  // no commercial policy needed (no money is calculated by finalizing a review with no policy).
  async function seedPendingApproval(displayName: string) {
    const partner = await finance.seedPartner({ displayName });
    const { reviewRef } = await reviews.seedDirectReview(partner, "2026-08", { status: "IN_REVIEW" });
    return { partner, reviewRef };
  }

  // Step 18C: the SAME live-pending-review shape as seedPendingApproval above, but the underlying
  // Partner is seeded into `finance.hiddenRegion` - a region grantFixtureRegion() never grants to
  // ANY fixture identity (manager/head/viewer/analyst). This is the established "record-scope
  // contrast" idiom every other Finance/Partner-Reviews e2e fixture already uses (see
  // finance-agreements-onboarding.spec.ts / partner-reviews-workspace.spec.ts's own `fx.hiddenRegion`
  // seeds) - here it proves the Approval Queue's own live re-derivation inherits Partner Reviews'
  // record-scope gate, independent of the acting role's Operations feature/action grants (Head holds
  // full view_approval_queue yet still cannot see a hidden-region item).
  async function seedScopedOutPendingApproval(displayName: string) {
    const partner = await finance.seedPartner({ displayName, regionIds: [finance.hiddenRegion] });
    const { reviewRef } = await reviews.seedDirectReview(partner, "2026-08", { status: "IN_REVIEW" });
    return { partner, reviewRef };
  }

  // Raw Firestore snapshot of a Partner doc - used to prove a Task/Reminder lifecycle running against
  // this Partner as its target never mutates the Partner record itself (cross-module immutability).
  async function snapshotPartner(partnerRef: string): Promise<PartnerDoc | null> {
    return getPartnerDocByRef(partnerRef);
  }

  async function finalizeReview(reviewRef: string, as: RoleName = "head") {
    const actor = await finance.actorOf(as);
    return must(await finalizePartnerReview(actor, reviewRef, { expectedDocVersion: 1 }, randomUUID()), "finalizePartnerReview");
  }

  async function cleanupAll() {
    const db = getAdminFirestore();
    for (const ref of taskRefs.splice(0)) await db.recursiveDelete(operationsTasksCollection().doc(ref)).catch(() => undefined);
    for (const ref of reminderRefs.splice(0)) await db.recursiveDelete(operationsRemindersCollection().doc(ref)).catch(() => undefined);
    await reviews.cleanupAll();
    await finance.cleanupAll();
  }

  return { finance, reviews, seedTask, seedReminder, seedPendingApproval, seedScopedOutPendingApproval, snapshotPartner, finalizeReview, cleanupAll };
}

export type OperationsFixtures = ReturnType<typeof createOperationsFixtures>;
