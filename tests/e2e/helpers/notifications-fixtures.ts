import { resolveActor } from "@/server/authz/actor";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { createTask } from "@/server/operations";
import { operationsTasksCollection } from "@/server/operations/firestore";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";
import { notificationsCollection } from "@/server/notifications/firestore";

// Notifications Completion e2e helpers - mirrors tests/e2e/helpers/notes-meetings-fixtures.ts's own
// signInAs/VIEWPORTS idiom exactly (the same idiom every stage's own e2e suite uses).
export { PASSWORD, VIEWPORTS, emailFor, signInAs, waitForHydration, noDocumentOverflow, collectBrowserErrors } from "./notes-meetings-fixtures";

import { emailFor } from "./notes-meetings-fixtures";

export async function actorUserRefFor(role: string): Promise<string> {
  const auth = getAdminAuth();
  const user = await auth.getUserByEmail(emailFor(role));
  const actor = await resolveActor(user.uid);
  if (!actor) throw new Error(`no resolved actor for ${role}`);
  return actor.userRef;
}

// A real Partner (the Task's target) + a real Task assigned to `assigneeRole`, created through the
// TRUSTED createTask service (never a hand-rolled Firestore write) - the same "direct service-layer
// fixture, the UI interaction under test is reserved for the feature actually being tested" idiom
// notes-meetings-fixtures.ts's own seedRealPartner already established in this codebase. This is what
// fires the REAL TASK_ASSIGNED notification hook (src/server/operations/task-service.ts) - nothing
// here is mocked; it is the exact code path a real "New Task" form submission would have taken.
export async function seedRealTaskAssignedTo(assigneeRole: string, title: string, options: { regionIds?: string[] } = {}): Promise<{ taskRef: string; partnerRef: string; docVersion: number }> {
  const auth = getAdminAuth();
  const managerUser = await auth.getUserByEmail(emailFor("manager"));
  const manager = await resolveActor(managerUser.uid);
  if (!manager) throw new Error("no resolved actor for manager@creatorops.com");

  const partnerResult = await createPartner(manager, { displayName: `Notifications E2E Partner ${Date.now()}`, regionIds: ["Kerala"] }, `ntf-e2e-partner-${Date.now()}`);
  if (!partnerResult.ok) throw new Error(`seedRealTaskAssignedTo: createPartner failed: ${partnerResult.code} - ${partnerResult.message}`);
  const partnerRef = (partnerResult.data as { partnerRef: string }).partnerRef;

  const assigneeUserRef = await actorUserRefFor(assigneeRole);
  const regionIds = options.regionIds ?? ["Kerala"];
  const taskResult = await createTask(manager, { title, target: { targetType: "PARTNER", targetRef: partnerRef }, assigneeUserRef, priority: "HIGH", regionIds }, `ntf-e2e-task-${Date.now()}`);
  if (!taskResult.ok) throw new Error(`seedRealTaskAssignedTo: createTask failed: ${taskResult.code} - ${taskResult.message}`);

  return { taskRef: taskResult.data.taskRef, partnerRef, docVersion: taskResult.data.docVersion };
}

export async function cleanupTaskAndPartner(taskRef: string, partnerRef: string): Promise<void> {
  const db = getAdminFirestore();
  await db.recursiveDelete(operationsTasksCollection().doc(taskRef));
  const snap = await partnersCollection().where("partnerRef", "==", partnerRef).limit(1).get();
  if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
}

export async function cleanupNotificationsFor(recipientUserRef: string): Promise<void> {
  const db = getAdminFirestore();
  const snap = await notificationsCollection().where("recipientUserRef", "==", recipientUserRef).get();
  await Promise.all(snap.docs.map((doc) => db.recursiveDelete(doc.ref)));
}
