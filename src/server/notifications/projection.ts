import { getUserDoc } from "@/server/authz/firestore";

import {
  buildActionItemAssignedCopy,
  buildActionItemPromotedCopy,
  buildAssignmentCreatedCopy,
  buildContentReviewDecisionCopy,
  buildMeetingCreatedCopy,
  buildMeetingRevisedCopy,
  buildReportFinalizedCopy,
  buildReportSupersededCopy,
  buildTaskAssignedCopy,
  buildTaskReassignedCopy,
} from "./copy";
import { assignmentDeepLink, contentDeepLink, meetingOwnerDeepLink, reportDeepLink, taskDeepLink } from "./deep-links";
import { createNotification } from "./notification-service";

// The explicit, bounded event catalog (spec section 4/28). One function per supported event type -
// each resolves its own recipient(s) SERVER-side (spec section 6: never inferred from role rank,
// never broadcast, fail closed/do not emit when recipient context is insufficient), builds safe copy
// + a deep link, and calls createNotification. See docs/CREATOROPS_CONTINUITY.md for the 5
// intentionally-unsupported event classes and why each is out of scope this stage.
//
// Every function here is called AFTER its source mutation's own Firestore transaction has already
// committed (spec section 18: "source truth commits first; notification projection is
// idempotent/retryable"). Every call site wraps these in a swallow-errors best-effort call (see each
// hook site's own comment) so a notification failure can never roll back or fail the source mutation
// that already succeeded - this is why every function below returns void and never throws for an
// ordinary "recipient not resolvable" case (it just doesn't emit).

async function resolveUserRefForUid(uid: string | null): Promise<string | null> {
  if (!uid) return null;
  const user = await getUserDoc(uid);
  return user?.userRef ?? null;
}

// --- Operations ---------------------------------------------------------------------------------
export async function notifyTaskAssigned(input: { taskRef: string; taskTitle: string; assigneeUserRef: string; actorUserRef: string; requestId: string }): Promise<void> {
  const copy = buildTaskAssignedCopy(input.taskTitle);
  await createNotification({
    recipientUserRef: input.assigneeUserRef,
    type: "TASK_ASSIGNED",
    sourceDomain: "OPERATIONS",
    sourceRef: input.taskRef,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: taskDeepLink(input.taskRef),
    createdByUserRef: input.actorUserRef,
    requestId: input.requestId,
  });
}

// Judgment call (documented in the stage completion report): the PREVIOUS assignee is deliberately
// NOT notified of "you were unassigned" - the spec's event catalog only asks for the new assignee's
// attention, there is no established safe-copy pattern for a "no longer assigned" event anywhere in
// this codebase, and adding one would be new, undirected scope. `docVersion` is the distinguisher so
// a later reassignment back to the same person still produces a fresh notification.
export async function notifyTaskReassigned(input: { taskRef: string; taskTitle: string; assigneeUserRef: string; docVersion: number; actorUserRef: string; requestId: string }): Promise<void> {
  const copy = buildTaskReassignedCopy(input.taskTitle);
  await createNotification({
    recipientUserRef: input.assigneeUserRef,
    type: "TASK_REASSIGNED",
    sourceDomain: "OPERATIONS",
    sourceRef: input.taskRef,
    distinguisher: String(input.docVersion),
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: taskDeepLink(input.taskRef),
    createdByUserRef: input.actorUserRef,
    requestId: input.requestId,
  });
}

// --- Notes/Meetings -------------------------------------------------------------------------------
export async function notifyMeetingParticipants(input: { meetingRef: string; meetingTitle: string; ownerType: string; ownerRef: string; participantUserRefs: string[]; organizerUserRef: string; actorUserRef: string; requestId: string }): Promise<void> {
  const deepLink = meetingOwnerDeepLink(input.ownerType, input.ownerRef);
  if (!deepLink) return; // fail closed: no known route for this owner type
  const copy = buildMeetingCreatedCopy(input.meetingTitle);
  const recipients = new Set(input.participantUserRefs.filter((ref) => ref !== input.organizerUserRef));
  await Promise.all(
    [...recipients].map((recipientUserRef) =>
      createNotification({ recipientUserRef, type: "MEETING_CREATED", sourceDomain: "NOTES_MEETINGS", sourceRef: input.meetingRef, title: copy.title, bodyPreview: copy.bodyPreview, deepLink, createdByUserRef: input.actorUserRef, requestId: input.requestId }),
    ),
  );
}

export async function notifyMeetingRevised(input: { meetingRef: string; meetingTitle: string; ownerType: string; ownerRef: string; participantUserRefs: string[]; docVersion: number; actorUserRef: string; requestId: string }): Promise<void> {
  const deepLink = meetingOwnerDeepLink(input.ownerType, input.ownerRef);
  if (!deepLink) return;
  const copy = buildMeetingRevisedCopy(input.meetingTitle);
  const recipients = new Set(input.participantUserRefs.filter((ref) => ref !== input.actorUserRef));
  await Promise.all(
    [...recipients].map((recipientUserRef) =>
      createNotification({
        recipientUserRef,
        type: "MEETING_REVISED",
        sourceDomain: "NOTES_MEETINGS",
        sourceRef: input.meetingRef,
        distinguisher: String(input.docVersion),
        title: copy.title,
        bodyPreview: copy.bodyPreview,
        deepLink,
        createdByUserRef: input.actorUserRef,
        requestId: input.requestId,
      }),
    ),
  );
}

export async function notifyActionItemAssigned(input: { actionItemRef: string; actionItemText: string; ownerType: string; ownerRef: string; assigneeUserRef: string; actorUserRef: string; requestId: string }): Promise<void> {
  const deepLink = meetingOwnerDeepLink(input.ownerType, input.ownerRef);
  if (!deepLink) return;
  const copy = buildActionItemAssignedCopy(input.actionItemText);
  await createNotification({
    recipientUserRef: input.assigneeUserRef,
    type: "ACTION_ITEM_ASSIGNED",
    sourceDomain: "NOTES_MEETINGS",
    sourceRef: input.actionItemRef,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink,
    createdByUserRef: input.actorUserRef,
    requestId: input.requestId,
  });
}

// Deliberately NOT also firing notifyTaskAssigned for the resulting system-generated Task (spec
// section 21's "avoid noisy duplicates when Task assignment already covers the same
// recipient/event") - see task-service.ts's generateSystemTask call site: this stage's Task-assigned
// hook lives only on the MANUAL-origin createTask path, never on generateSystemTask, so a promotion
// only ever produces exactly this one notification, never two.
export async function notifyActionItemPromoted(input: { actionItemRef: string; taskRef: string; taskTitle: string; assigneeUserRef: string; actorUserRef: string; requestId: string }): Promise<void> {
  const copy = buildActionItemPromotedCopy(input.taskTitle);
  await createNotification({
    recipientUserRef: input.assigneeUserRef,
    type: "ACTION_ITEM_PROMOTED",
    sourceDomain: "NOTES_MEETINGS",
    sourceRef: input.actionItemRef,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: taskDeepLink(input.taskRef),
    createdByUserRef: input.actorUserRef,
    requestId: input.requestId,
  });
}

// --- Content -------------------------------------------------------------------------------------
// Recipient: the owning Assignment's ownerUid (a raw Firebase uid on the Assignment head - resolved
// to a userRef here, never stored/compared as a raw uid). Skipped entirely (fail closed, spec
// section 6) when ownerUid is null - there is no internal reviewer to notify for that Assignment.
export async function notifyContentReviewDecision(input: { contentRef: string; ownerUid: string | null; decision: "approved" | "revision_requested"; newVersion: number; actorUserRef: string; requestId: string }): Promise<void> {
  const recipientUserRef = await resolveUserRefForUid(input.ownerUid);
  if (!recipientUserRef || recipientUserRef === input.actorUserRef) return;
  const copy = buildContentReviewDecisionCopy(input.decision);
  await createNotification({
    recipientUserRef,
    type: "CONTENT_REVIEW_DECISION",
    sourceDomain: "CONTENT",
    sourceRef: input.contentRef,
    distinguisher: `${input.decision}:${input.newVersion}`,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: contentDeepLink(input.contentRef),
    createdByUserRef: input.actorUserRef,
    requestId: input.requestId,
  });
}

// --- Reports ---------------------------------------------------------------------------------------
// Recipient: the finalized version's own drafter (actorUserRef), skipped when the person finalizing
// is the same person who drafted it (spec's own "only when finalizedByUserRef !== actorUserRef" -
// no attention value in notifying someone of their own just-completed action).
export async function notifyReportFinalized(input: { runRef: string; reportId: string; version: number; drafterUserRef: string; finalizedByUserRef: string; requestId: string }): Promise<void> {
  if (input.drafterUserRef === input.finalizedByUserRef) return;
  const copy = buildReportFinalizedCopy();
  await createNotification({
    recipientUserRef: input.drafterUserRef,
    type: "REPORT_FINALIZED",
    sourceDomain: "REPORTS",
    sourceRef: input.runRef,
    distinguisher: `finalized:${input.version}`,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: reportDeepLink(input.reportId),
    createdByUserRef: input.finalizedByUserRef,
    requestId: input.requestId,
  });
}

export async function notifyReportSuperseded(input: { runRef: string; reportId: string; supersededVersion: number; supersededDrafterUserRef: string; supersedingActorUserRef: string; requestId: string }): Promise<void> {
  if (input.supersededDrafterUserRef === input.supersedingActorUserRef) return;
  const copy = buildReportSupersededCopy();
  await createNotification({
    recipientUserRef: input.supersededDrafterUserRef,
    type: "REPORT_SUPERSEDED",
    sourceDomain: "REPORTS",
    sourceRef: input.runRef,
    distinguisher: `superseded:${input.supersededVersion}`,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: reportDeepLink(input.reportId),
    createdByUserRef: input.supersedingActorUserRef,
    requestId: input.requestId,
  });
}

// --- Campaign/Assignment/Content -------------------------------------------------------------------
// Recipient: the new Assignment's ownerUid (inherited from its Campaign - see
// src/server/assignments/assignment-service.ts's own comment: "Assignment has no separately-settable
// owner of its own"). Skipped when null - never inferred from role rank.
export async function notifyAssignmentCreated(input: { assignmentRef: string; ownerUid: string | null; actorUserRef: string; requestId: string }): Promise<void> {
  const recipientUserRef = await resolveUserRefForUid(input.ownerUid);
  if (!recipientUserRef || recipientUserRef === input.actorUserRef) return;
  const copy = buildAssignmentCreatedCopy();
  await createNotification({
    recipientUserRef,
    type: "ASSIGNMENT_CREATED",
    sourceDomain: "ASSIGNMENTS",
    sourceRef: input.assignmentRef,
    title: copy.title,
    bodyPreview: copy.bodyPreview,
    deepLink: assignmentDeepLink(input.assignmentRef),
    createdByUserRef: input.actorUserRef,
    requestId: input.requestId,
  });
}
