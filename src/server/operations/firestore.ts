import { getAdminFirestore } from "@/server/firebase/admin";

import { sourceKeyDocId } from "./ids";
import {
  operationsReminderHeadDocSchema,
  operationsTaskHeadDocSchema,
  reminderEventSchema,
  reminderGenerationClaimDocSchema,
  taskEventSchema,
  taskGenerationClaimDocSchema,
  taskVersionDocSchema,
  type OperationsReminderHeadDoc,
  type OperationsTaskHeadDoc,
  type ReminderEvent,
  type ReminderGenerationClaimDoc,
  type TaskEvent,
  type TaskGenerationClaimDoc,
  type TaskVersionDoc,
} from "./types";

// Step 18A: collection accessors + parse-on-read / parse-on-write helpers for Operations Tasks and
// Reminders. Mirrors src/server/finance-payments/firestore.ts's own discipline exactly: no delete
// anywhere (a Task/Reminder is cancelled, never removed, and a Task version is never rewritten -
// only txCreateTaskVersion exists).

export const OPERATIONS_COLLECTIONS = {
  operationsTasks: "operationsTasks",
  taskVersions: "versions", // subcollection under operationsTasks/{taskRef}
  taskEvents: "events", // subcollection under operationsTasks/{taskRef}
  operationsTaskGenerationClaims: "operationsTaskGenerationClaims",
  operationsReminders: "operationsReminders",
  reminderEvents: "events", // subcollection under operationsReminders/{reminderRef}
  operationsReminderGenerationClaims: "operationsReminderGenerationClaims",
} as const;

export const MAX_TASK_VERSION_SUMMARIES = 50;
export const DEFAULT_TASK_EVENT_PAGE = 50;
export const MAX_TASK_EVENT_PAGE = 100;
export const DEFAULT_REMINDER_EVENT_PAGE = 50;
export const MAX_REMINDER_EVENT_PAGE = 100;

export function operationsTasksCollection() {
  return getAdminFirestore().collection(OPERATIONS_COLLECTIONS.operationsTasks);
}
export function taskVersionsCollection(taskRef: string) {
  return operationsTasksCollection().doc(taskRef).collection(OPERATIONS_COLLECTIONS.taskVersions);
}
export function taskEventsCollection(taskRef: string) {
  return operationsTasksCollection().doc(taskRef).collection(OPERATIONS_COLLECTIONS.taskEvents);
}
export function taskGenerationClaimsCollection() {
  return getAdminFirestore().collection(OPERATIONS_COLLECTIONS.operationsTaskGenerationClaims);
}
export function operationsRemindersCollection() {
  return getAdminFirestore().collection(OPERATIONS_COLLECTIONS.operationsReminders);
}
export function reminderEventsCollection(reminderRef: string) {
  return operationsRemindersCollection().doc(reminderRef).collection(OPERATIONS_COLLECTIONS.reminderEvents);
}
export function reminderGenerationClaimsCollection() {
  return getAdminFirestore().collection(OPERATIONS_COLLECTIONS.operationsReminderGenerationClaims);
}

export function taskVersionDocId(version: number): string {
  return String(version);
}

// --- Reads: safeParse, null on missing or malformed ----------------------------------------------
export async function getTaskHeadDoc(taskRef: string): Promise<OperationsTaskHeadDoc | null> {
  const snapshot = await operationsTasksCollection().doc(taskRef).get();
  if (!snapshot.exists) return null;
  const result = operationsTaskHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getTaskVersionDoc(taskRef: string, version: number): Promise<TaskVersionDoc | null> {
  const snapshot = await taskVersionsCollection(taskRef).doc(taskVersionDocId(version)).get();
  if (!snapshot.exists) return null;
  const result = taskVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function listTaskVersionDocs(taskRef: string, limit = MAX_TASK_VERSION_SUMMARIES): Promise<{ versions: TaskVersionDoc[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_TASK_VERSION_SUMMARIES));
  const snapshot = await taskVersionsCollection(taskRef)
    .orderBy("version", "desc")
    .limit(bound + 1)
    .get();
  const versions: TaskVersionDoc[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = taskVersionDocSchema.safeParse(doc.data());
    if (parsed.success) versions.push(parsed.data);
  }
  return { versions, hasMore: snapshot.docs.length > bound };
}

export async function listTaskEventDocs(taskRef: string, limit = DEFAULT_TASK_EVENT_PAGE): Promise<{ events: TaskEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_TASK_EVENT_PAGE));
  const snapshot = await taskEventsCollection(taskRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();
  const events: TaskEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = taskEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

export async function getTaskGenerationClaimDoc(sourceKey: string): Promise<TaskGenerationClaimDoc | null> {
  const snapshot = await taskGenerationClaimsCollection().doc(sourceKeyDocId(sourceKey)).get();
  if (!snapshot.exists) return null;
  const result = taskGenerationClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function getReminderHeadDoc(reminderRef: string): Promise<OperationsReminderHeadDoc | null> {
  const snapshot = await operationsRemindersCollection().doc(reminderRef).get();
  if (!snapshot.exists) return null;
  const result = operationsReminderHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function listReminderEventDocs(reminderRef: string, limit = DEFAULT_REMINDER_EVENT_PAGE): Promise<{ events: ReminderEvent[]; hasMore: boolean }> {
  const bound = Math.max(1, Math.min(limit, MAX_REMINDER_EVENT_PAGE));
  const snapshot = await reminderEventsCollection(reminderRef)
    .orderBy("createdAt", "desc")
    .limit(bound + 1)
    .get();
  const events: ReminderEvent[] = [];
  for (const doc of snapshot.docs.slice(0, bound)) {
    const parsed = reminderEventSchema.safeParse(doc.data());
    if (parsed.success) events.push(parsed.data);
  }
  return { events, hasMore: snapshot.docs.length > bound };
}

export async function getReminderGenerationClaimDoc(sourceKey: string): Promise<ReminderGenerationClaimDoc | null> {
  const snapshot = await reminderGenerationClaimsCollection().doc(sourceKeyDocId(sourceKey)).get();
  if (!snapshot.exists) return null;
  const result = reminderGenerationClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction reads (Firestore requires every read before any write) ------------------------
export async function txGetTaskHead(tx: FirebaseFirestore.Transaction, taskRef: string): Promise<OperationsTaskHeadDoc | null> {
  const snapshot = await tx.get(operationsTasksCollection().doc(taskRef));
  if (!snapshot.exists) return null;
  const result = operationsTaskHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetTaskVersion(tx: FirebaseFirestore.Transaction, taskRef: string, version: number): Promise<TaskVersionDoc | null> {
  const snapshot = await tx.get(taskVersionsCollection(taskRef).doc(taskVersionDocId(version)));
  if (!snapshot.exists) return null;
  const result = taskVersionDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetTaskGenerationClaim(tx: FirebaseFirestore.Transaction, sourceKey: string): Promise<TaskGenerationClaimDoc | null> {
  const snapshot = await tx.get(taskGenerationClaimsCollection().doc(sourceKeyDocId(sourceKey)));
  if (!snapshot.exists) return null;
  const result = taskGenerationClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetReminderHead(tx: FirebaseFirestore.Transaction, reminderRef: string): Promise<OperationsReminderHeadDoc | null> {
  const snapshot = await tx.get(operationsRemindersCollection().doc(reminderRef));
  if (!snapshot.exists) return null;
  const result = operationsReminderHeadDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

export async function txGetReminderGenerationClaim(tx: FirebaseFirestore.Transaction, sourceKey: string): Promise<ReminderGenerationClaimDoc | null> {
  const snapshot = await tx.get(reminderGenerationClaimsCollection().doc(sourceKeyDocId(sourceKey)));
  if (!snapshot.exists) return null;
  const result = reminderGenerationClaimDocSchema.safeParse(snapshot.data());
  return result.success ? result.data : null;
}

// --- In-transaction writes: parsed on WRITE, so an invalid doc can never be persisted --------------
export function txSetTaskHead(tx: FirebaseFirestore.Transaction, head: OperationsTaskHeadDoc): void {
  tx.set(operationsTasksCollection().doc(head.taskRef), operationsTaskHeadDocSchema.parse(head));
}

export function txCreateTaskVersion(tx: FirebaseFirestore.Transaction, version: TaskVersionDoc): void {
  tx.create(taskVersionsCollection(version.taskRef).doc(taskVersionDocId(version.version)), taskVersionDocSchema.parse(version));
}

export function txCreateTaskGenerationClaim(tx: FirebaseFirestore.Transaction, claim: TaskGenerationClaimDoc): void {
  tx.create(taskGenerationClaimsCollection().doc(sourceKeyDocId(claim.sourceKey)), taskGenerationClaimDocSchema.parse(claim));
}

export function txSetReminderHead(tx: FirebaseFirestore.Transaction, head: OperationsReminderHeadDoc): void {
  tx.set(operationsRemindersCollection().doc(head.reminderRef), operationsReminderHeadDocSchema.parse(head));
}

export function txCreateReminderGenerationClaim(tx: FirebaseFirestore.Transaction, claim: ReminderGenerationClaimDoc): void {
  tx.create(reminderGenerationClaimsCollection().doc(sourceKeyDocId(claim.sourceKey)), reminderGenerationClaimDocSchema.parse(claim));
}

// Appends one event INSIDE the caller's transaction - tx.create with a fresh id, never rewritten,
// never deleted. The event builders (task-events.ts/reminder-events.ts) own the metadata allowlist;
// this file only ever writes an already-redacted event.
export function txCreateTaskEvent(tx: FirebaseFirestore.Transaction, taskRef: string, eventId: string, event: TaskEvent): void {
  tx.create(taskEventsCollection(taskRef).doc(eventId), taskEventSchema.parse(event));
}

export function txCreateReminderEvent(tx: FirebaseFirestore.Transaction, reminderRef: string, eventId: string, event: ReminderEvent): void {
  tx.create(reminderEventsCollection(reminderRef).doc(eventId), reminderEventSchema.parse(event));
}

// --- Bounded scoped lists (section 12/18: never fetch a whole collection) --------------------------
// Deliberately simple bounded queries (a single equality/range filter plus an order and a limit)
// rather than the full scope-first branch-merge cursor engine Finance's workspaces use - Tasks/
// Reminders are visible-by-assignee-or-explicit-scope-grant, a much narrower shape than Finance's
// multi-dimensional Partner/Vendor scope, and section 12's own index list ("assignee + status +
// dueAt", "targetType + targetRef + status", "status + dueAt") is exactly one Firestore composite
// index per query shape below - no merge-across-branches needed. Every list caller still applies
// isOperationsRecordInScope as an in-memory post-filter (operations-gate.ts) so a malformed or
// unexpected head can never leak past a missing index entry.
export const MAX_TASK_LIST_SCAN = 200;

export async function listTaskHeadsByAssignee(assigneeUserRef: string, status: string | undefined, limit: number): Promise<OperationsTaskHeadDoc[]> {
  let query: FirebaseFirestore.Query = operationsTasksCollection().where("assigneeUserRef", "==", assigneeUserRef);
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("updatedAt", "desc").limit(Math.min(limit, MAX_TASK_LIST_SCAN)).get();
  return parseTaskHeads(snapshot);
}

export async function listTaskHeadsByTarget(targetType: string, targetRef: string, status: string | undefined, limit: number): Promise<OperationsTaskHeadDoc[]> {
  let query: FirebaseFirestore.Query = operationsTasksCollection().where("target.targetType", "==", targetType).where("target.targetRef", "==", targetRef);
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("updatedAt", "desc").limit(Math.min(limit, MAX_TASK_LIST_SCAN)).get();
  return parseTaskHeads(snapshot);
}

// The bounded fallback scan used only for a Super-Admin/global-scope "everything" view or a
// status-only filter - still capped at MAX_TASK_LIST_SCAN, never the whole collection.
export async function listTaskHeadsBounded(status: string | undefined, limit: number): Promise<OperationsTaskHeadDoc[]> {
  let query: FirebaseFirestore.Query = operationsTasksCollection();
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("updatedAt", "desc").limit(Math.min(limit, MAX_TASK_LIST_SCAN)).get();
  return parseTaskHeads(snapshot);
}

function parseTaskHeads(snapshot: FirebaseFirestore.QuerySnapshot): OperationsTaskHeadDoc[] {
  const heads: OperationsTaskHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = operationsTaskHeadDocSchema.safeParse(doc.data());
    if (parsed.success) heads.push(parsed.data);
  }
  return heads;
}

export const MAX_REMINDER_LIST_SCAN = 200;

export async function listReminderHeadsByRecipient(recipientUserRef: string, status: string | undefined, limit: number): Promise<OperationsReminderHeadDoc[]> {
  let query: FirebaseFirestore.Query = operationsRemindersCollection().where("recipientUserRef", "==", recipientUserRef);
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("reminderAt", "asc").limit(Math.min(limit, MAX_REMINDER_LIST_SCAN)).get();
  return parseReminderHeads(snapshot);
}

export async function listReminderHeadsByTask(taskRef: string, status: string | undefined, limit: number): Promise<OperationsReminderHeadDoc[]> {
  let query: FirebaseFirestore.Query = operationsRemindersCollection().where("taskRef", "==", taskRef);
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("reminderAt", "asc").limit(Math.min(limit, MAX_REMINDER_LIST_SCAN)).get();
  return parseReminderHeads(snapshot);
}

export async function listReminderHeadsBounded(status: string | undefined, limit: number): Promise<OperationsReminderHeadDoc[]> {
  let query: FirebaseFirestore.Query = operationsRemindersCollection();
  if (status) query = query.where("status", "==", status);
  const snapshot = await query.orderBy("reminderAt", "asc").limit(Math.min(limit, MAX_REMINDER_LIST_SCAN)).get();
  return parseReminderHeads(snapshot);
}

function parseReminderHeads(snapshot: FirebaseFirestore.QuerySnapshot): OperationsReminderHeadDoc[] {
  const heads: OperationsReminderHeadDoc[] = [];
  for (const doc of snapshot.docs) {
    const parsed = operationsReminderHeadDocSchema.safeParse(doc.data());
    if (parsed.success) heads.push(parsed.data);
  }
  return heads;
}
