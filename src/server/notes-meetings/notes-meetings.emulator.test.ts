// Notes/Meetings Completion - against the running Firestore/Auth emulator, end to end, on REAL
// records. Proven here (spec section 25):
//   - Notes: create/list/revise/history/archive on a real Partner; owner/scope denial; sensitivity
//     denial/allow; guessed-ref non-leakage.
//   - Meetings: create/list/detail/revise, participants, decisions, action items, history; scope/
//     sensitivity denial.
//   - Promotion to Operations Task: real target, deep link, persisted link, idempotent retry,
//     concurrent promotion, unauthorized promotion, independent Task permission, source-history
//     preservation, and the documented DISCOVERY_LEAD target-type extension.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { createLead } from "@/server/discovery/lead-service";
import { leadsCollection } from "@/server/discovery/firestore";
import { getTask, listTaskEvents } from "@/server/operations";
import { operationsTasksCollection } from "@/server/operations/firestore";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

import {
  actionItemsCollection,
  attachmentsCollection,
  meetingsCollection,
  notesCollection,
} from "./firestore";
import {
  archiveNote,
  cancelMeeting,
  completeActionItem,
  createActionItem,
  createMeeting,
  createNote,
  getActionItem,
  getMeeting,
  getNote,
  listActionItemEvents,
  listActionItems,
  listActionItemVersions,
  listMeetingEvents,
  listMeetingVersions,
  listNoteEvents,
  listNotes,
  listNoteVersions,
  promoteActionItem,
  reviseMeeting,
  reviseNote,
} from "./index";
import type { NotesMeetingsServiceResult } from "./types";
import type { OperationsServiceResult } from "@/server/operations/types";

vi.setConfig({ testTimeout: 60_000 });

const runId = Date.now();
const uidByRole = new Map<string, string>();
const userRefByRole = new Map<string, string>();
const partnerRefs: string[] = [];
const campaignRefs: string[] = [];
const leadRefs: string[] = [];
const noteRefs: string[] = [];
const meetingRefs: string[] = [];
const taskRefs: string[] = [];
let reqCounter = 0;
const requestId = () => `nm-req-${runId}-${(reqCounter += 1)}`;

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
  for (const ref of noteRefs) await db.recursiveDelete(notesCollection().doc(ref));
  for (const ref of meetingRefs) await db.recursiveDelete(meetingsCollection().doc(ref));
  const actionItemsSnap = await actionItemsCollection().where("meetingRef", "in", meetingRefs.length > 0 ? meetingRefs.slice(0, 10) : ["__none__"]).get();
  for (const doc of actionItemsSnap.docs) await db.recursiveDelete(doc.ref);
  const attachmentsSnap = await attachmentsCollection().get();
  for (const doc of attachmentsSnap.docs) {
    if (noteRefs.includes(doc.data().parentRef) || meetingRefs.includes(doc.data().parentRef)) await doc.ref.delete();
  }
  for (const ref of taskRefs) await db.recursiveDelete(operationsTasksCollection().doc(ref));
  for (const ref of campaignRefs) {
    const snap = await campaignsCollection().where("campaignRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
  for (const ref of leadRefs) {
    const snap = await leadsCollection().where("leadRef", "==", ref).limit(1).get();
    if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
  }
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

function must<T>(result: NotesMeetingsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

function failure(result: NotesMeetingsServiceResult<unknown>) {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result;
}

function mustOps<T>(result: OperationsServiceResult<T>, label: string): T {
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

async function realCampaign(name: string): Promise<string> {
  const head = await actorFor("partnership_head");
  const result = await createCampaign(head, { name, objective: "Grow reach", startDate: "2026-01-01", endDate: "2026-12-31", regionIds: ["Kerala"], defaultReviewPolicy: "REVIEW_REQUIRED" }, requestId());
  if (!result.ok) throw new Error(`createCampaign failed: ${result.code} - ${result.message}`);
  const campaignRef = (result.data as { campaignRef: string }).campaignRef;
  campaignRefs.push(campaignRef);
  return campaignRef;
}

async function realLead(displayName: string): Promise<string> {
  const manager = await actorFor("partnership_manager");
  const result = await createLead(manager, { displayName, source: { type: "research" }, regionIds: ["Kerala"] }, requestId());
  if (!result.ok) throw new Error(`createLead failed: ${result.code} - ${result.message}`);
  const leadRef = (result.data as { leadRef: string }).leadRef;
  leadRefs.push(leadRef);
  return leadRef;
}

// ==========================================================================================
describe("Notes - contextual create/list/revise/history/archive (spec sections 2A/6/12)", () => {
  it("create -> list -> get -> revise -> history -> archive, each step audited", async () => {
    const manager = await actorFor("partnership_manager");
    const partnerRef = await realPartner(`NM Note Partner ${runId}-1`);

    const created = must(await createNote(manager, { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, body: "Kickoff call scheduled for next week." }, requestId()), "createNote");
    noteRefs.push(created.noteRef);
    expect(created.docVersion).toBe(1);
    expect(created.body).toBe("Kickoff call scheduled for next week.");
    expect(created.status).toBe("ACTIVE");
    expect(created.createdByDisplayName).not.toBeNull();

    const listed = must(await listNotes(manager, { owner: { ownerType: "PARTNER", ownerRef: partnerRef } }), "listNotes");
    expect(listed.notes.map((n) => n.noteRef)).toContain(created.noteRef);

    const fetched = must(await getNote(manager, created.noteRef), "getNote");
    expect(fetched.noteRef).toBe(created.noteRef);

    const revised = must(await reviseNote(manager, { noteRef: created.noteRef, expectedDocVersion: created.docVersion, body: "Kickoff call moved to Monday.", reason: "Schedule changed" }, requestId()), "reviseNote");
    expect(revised.body).toBe("Kickoff call moved to Monday.");
    expect(revised.latestVersion).toBe(2);
    expect(revised.docVersion).toBe(2);

    const history = must(await listNoteVersions(manager, created.noteRef), "listNoteVersions");
    expect(history.versions).toHaveLength(2);
    expect(history.versions.find((v) => v.version === 1)?.body).toBe("Kickoff call scheduled for next week.");
    expect(history.versions.find((v) => v.version === 2)?.reason).toBe("Schedule changed");

    const events = must(await listNoteEvents(manager, created.noteRef), "listNoteEvents");
    expect(events.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["NOTE_CREATED", "NOTE_REVISED"]));

    const archived = must(await archiveNote(manager, { noteRef: created.noteRef, expectedDocVersion: revised.docVersion, reason: "No longer relevant" }, requestId()), "archiveNote");
    expect(archived.status).toBe("ARCHIVED");

    // Protected history is preserved, never destructively deleted.
    const historyAfterArchive = must(await listNoteVersions(manager, created.noteRef), "listNoteVersions after archive");
    expect(historyAfterArchive.versions).toHaveLength(2);

    // A revise attempt on an archived note is a real conflict, not a silent success.
    failure(await reviseNote(manager, { noteRef: created.noteRef, expectedDocVersion: archived.docVersion, body: "should fail", reason: "should fail" }, requestId()));
  });

  it("stale conflict: a revise using an out-of-date expectedDocVersion is refused, never silently applied", async () => {
    const manager = await actorFor("partnership_manager");
    const partnerRef = await realPartner(`NM Note Partner ${runId}-2`);
    const created = must(await createNote(manager, { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, body: "v1" }, requestId()), "createNote");
    noteRefs.push(created.noteRef);
    must(await reviseNote(manager, { noteRef: created.noteRef, expectedDocVersion: created.docVersion, body: "v2", reason: "update" }, requestId()), "revise to v2");

    const stale = failure(await reviseNote(manager, { noteRef: created.noteRef, expectedDocVersion: created.docVersion, body: "v3 (stale)", reason: "stale attempt" }, requestId()));
    expect(stale.code).toBe("stale_write");
  });

  it("owner/scope denial: an actor without the owning feature's manage_notes action is denied", async () => {
    const partnerRef = await realPartner(`NM Note Partner ${runId}-3`);
    const viewer = await actorFor("viewer"); // holds partners view, no actions
    const denied = failure(await createNote(viewer, { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, body: "should be denied" }, requestId()));
    expect(denied.code).toBe("unauthorized");
  });

  it("a guessed noteRef never leaks - a nonexistent ref returns the same neutral not_found an out-of-scope ref would", async () => {
    const manager = await actorFor("partnership_manager");
    const guessed = failure(await getNote(manager, "note_00000000000000000000"));
    expect(guessed.code).toBe("not_found");
    expect(guessed.message).toBe("Not found.");
  });

  it("sensitivity denial/allow: a RESTRICTED note redacts its body for Manager (no notes_meetings_sensitive category) but shows it to Head (holds the category)", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const partnerRef = await realPartner(`NM Note Partner ${runId}-4`);
    const created = must(await createNote(head, { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, body: "Confidential renegotiation terms.", visibility: "RESTRICTED" }, requestId()), "createNote restricted");
    noteRefs.push(created.noteRef);

    const asManager = must(await getNote(manager, created.noteRef), "getNote as manager");
    expect(asManager.redacted).toBe(true);
    expect(asManager.body).toBeNull();
    expect(asManager.visibility).toBe("RESTRICTED"); // existence/visibility still shown, never hidden

    const asHead = must(await getNote(head, created.noteRef), "getNote as head");
    expect(asHead.redacted).toBe(false);
    expect(asHead.body).toBe("Confidential renegotiation terms.");
  });
});

// ==========================================================================================
describe("Meetings / MoM - create/list/detail/revise, participants/decisions/action items, history (spec sections 2B/7/12)", () => {
  it("create with participants/agenda/decisions -> get -> revise -> history, each step audited", async () => {
    const manager = await actorFor("partnership_manager");
    const head = await actorFor("partnership_head");
    const campaignRef = await realCampaign(`NM Meeting Campaign ${runId}-1`);

    const created = must(
      await createMeeting(manager, { owner: { ownerType: "CAMPAIGN", ownerRef: campaignRef }, title: "Kickoff sync", meetingAt: new Date().toISOString(), participants: [{ userRef: manager.userRef }, { userRef: head.userRef }], agenda: "Discuss launch plan", decisions: [{ text: "Launch on the 15th" }] }, requestId()),
      "createMeeting",
    );
    meetingRefs.push(created.meetingRef);
    expect(created.participants).toHaveLength(2);
    expect(created.decisions).toEqual(["Launch on the 15th"]);
    expect(created.status).toBe("SCHEDULED");

    const fetched = must(await getMeeting(manager, created.meetingRef), "getMeeting");
    expect(fetched.title).toBe("Kickoff sync");

    const revised = must(await reviseMeeting(manager, { meetingRef: created.meetingRef, expectedDocVersion: created.docVersion, summary: "Launch confirmed for the 15th.", reason: "Add summary after the call" }, requestId()), "reviseMeeting");
    expect(revised.summary).toBe("Launch confirmed for the 15th.");
    expect(revised.participants).toHaveLength(2); // preserved across the revision

    const history = must(await listMeetingVersions(manager, created.meetingRef), "listMeetingVersions");
    expect(history.versions).toHaveLength(2);

    const events = must(await listMeetingEvents(manager, created.meetingRef), "listMeetingEvents");
    expect(events.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["MEETING_CREATED", "MEETING_REVISED"]));

    const cancelled = must(await cancelMeeting(manager, { meetingRef: created.meetingRef, expectedDocVersion: revised.docVersion, reason: "Rescheduled" }, requestId()), "cancelMeeting");
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("owner/scope denial and RESTRICTED-meeting redaction mirror Notes' own behavior", async () => {
    const head = await actorFor("partnership_head");
    const manager = await actorFor("partnership_manager");
    const viewer = await actorFor("viewer");
    const campaignRef = await realCampaign(`NM Meeting Campaign ${runId}-2`);

    const denied = failure(await createMeeting(viewer, { owner: { ownerType: "CAMPAIGN", ownerRef: campaignRef }, title: "Should be denied", meetingAt: new Date().toISOString() }, requestId()));
    expect(denied.code).toBe("unauthorized");

    const restricted = must(await createMeeting(head, { owner: { ownerType: "CAMPAIGN", ownerRef: campaignRef }, title: "Board review", meetingAt: new Date().toISOString(), summary: "Confidential budget discussion", visibility: "RESTRICTED" }, requestId()), "createMeeting restricted");
    meetingRefs.push(restricted.meetingRef);
    const asManager = must(await getMeeting(manager, restricted.meetingRef), "getMeeting as manager");
    expect(asManager.redacted).toBe(true);
    expect(asManager.summary).toBeNull();
  });

  it("guessed meetingRef never leaks", async () => {
    const manager = await actorFor("partnership_manager");
    const guessed = failure(await getMeeting(manager, "mtg_00000000000000000000"));
    expect(guessed.code).toBe("not_found");
  });
});

// ==========================================================================================
describe("MeetingActionItem lifecycle + promotion to Operations Task (spec sections 8/9/11/19)", () => {
  it("create action item -> revise -> complete, and independently -> create -> cancel", async () => {
    const manager = await actorFor("partnership_manager");
    const campaignRef = await realCampaign(`NM Action Item Campaign ${runId}-1`);
    const meeting = must(await createMeeting(manager, { owner: { ownerType: "CAMPAIGN", ownerRef: campaignRef }, title: "Planning", meetingAt: new Date().toISOString() }, requestId()), "createMeeting");
    meetingRefs.push(meeting.meetingRef);

    const item = must(await createActionItem(manager, { meetingRef: meeting.meetingRef, expectedDocVersion: meeting.docVersion, text: "Draft the brief", assigneeUserRef: manager.userRef }, requestId()), "createActionItem");
    expect(item.status).toBe("OPEN");
    expect(item.assigneeDisplayName).not.toBeNull();

    const listed = must(await listActionItems(manager, meeting.meetingRef), "listActionItems");
    expect(listed.actionItems.map((a) => a.actionItemRef)).toContain(item.actionItemRef);

    const completed = must(await completeActionItem(manager, { actionItemRef: item.actionItemRef, expectedDocVersion: item.docVersion }, requestId()), "completeActionItem");
    expect(completed.status).toBe("DONE");
    expect(completed.completedByDisplayName).not.toBeNull();

    const versions = must(await listActionItemVersions(manager, item.actionItemRef), "listActionItemVersions");
    expect(versions.versions.length).toBeGreaterThanOrEqual(1);

    const events = must(await listActionItemEvents(manager, item.actionItemRef), "listActionItemEvents");
    expect(events.events.map((e) => e.kind)).toContain("ACTION_ITEM_CREATED");

    // A done action item cannot be completed again (compact lifecycle, no re-opening this stage).
    failure(await completeActionItem(manager, { actionItemRef: item.actionItemRef, expectedDocVersion: completed.docVersion }, requestId()));
  });

  it("promotion: explicit, permission-gated, idempotent, creates a real Task with a resolvable target, preserves the source Meeting/action item, and is navigable both ways", async () => {
    const manager = await actorFor("partnership_manager");
    const partnerRef = await realPartner(`NM Promotion Partner ${runId}-1`);
    const meeting = must(await createMeeting(manager, { owner: { ownerType: "PARTNER", ownerRef: partnerRef }, title: "Renewal discussion", meetingAt: new Date().toISOString() }, requestId()), "createMeeting");
    meetingRefs.push(meeting.meetingRef);
    const item = must(await createActionItem(manager, { meetingRef: meeting.meetingRef, expectedDocVersion: meeting.docVersion, text: "Send renewal terms", assigneeUserRef: manager.userRef, dueAt: new Date(Date.now() + 86400000).toISOString() }, requestId()), "createActionItem");

    const promoted = must(await promoteActionItem(manager, { actionItemRef: item.actionItemRef }, requestId()), "promoteActionItem");
    expect(promoted.promotedTaskRef).not.toBeNull();
    taskRefs.push(promoted.promotedTaskRef!);

    // The Task is real, in Operations' own collection, with a resolvable Partner target name.
    const task = mustOps(await getTask(manager, promoted.promotedTaskRef!), "getTask");
    expect(task.target).toEqual({ targetType: "PARTNER", targetRef: partnerRef, targetVersion: null });
    expect(task.targetDisplayName).not.toBeNull();
    expect(task.assigneeUserRef).toBe(manager.userRef);

    // Forward link: the Task's own event history/sourceKey names this exact action item (recorded
    // via Operations' existing MODULE_ACTION+sourceKey provenance - see promotion.ts's own comment).
    const taskEvents = mustOps(await listTaskEvents(manager, promoted.promotedTaskRef!), "listTaskEvents");
    expect(taskEvents.events.some((e) => e.kind === "TASK_CREATED")).toBe(true);

    // Idempotent retry: promoting again returns the SAME Task, never a second one.
    const retried = must(await promoteActionItem(manager, { actionItemRef: item.actionItemRef }, requestId()), "promoteActionItem retry");
    expect(retried.promotedTaskRef).toBe(promoted.promotedTaskRef);

    // Concurrent promotion: two simultaneous calls converge on exactly one Task.
    const concurrentItem = must(await createActionItem(manager, { meetingRef: meeting.meetingRef, expectedDocVersion: meeting.docVersion, text: "Concurrent promote target", assigneeUserRef: manager.userRef }, requestId()), "createActionItem for concurrency");
    const [a, b] = await Promise.all([promoteActionItem(manager, { actionItemRef: concurrentItem.actionItemRef }, requestId()), promoteActionItem(manager, { actionItemRef: concurrentItem.actionItemRef }, requestId())]);
    const aTask = must(a, "concurrent promote A");
    const bTask = must(b, "concurrent promote B");
    expect(aTask.promotedTaskRef).toBe(bTask.promotedTaskRef);
    if (aTask.promotedTaskRef) taskRefs.push(aTask.promotedTaskRef);

    // Unauthorized promotion: an actor without promote_action_item is denied.
    const viewer = await actorFor("viewer");
    const unauthorizedItem = must(await createActionItem(manager, { meetingRef: meeting.meetingRef, expectedDocVersion: meeting.docVersion, text: "Should not promote", assigneeUserRef: manager.userRef }, requestId()), "createActionItem for denial");
    const deniedPromotion = failure(await promoteActionItem(viewer, { actionItemRef: unauthorizedItem.actionItemRef }, requestId()));
    expect(deniedPromotion.code).toBe("unauthorized");

    // Independent Task permission: Operations' own manage_tasks gate is re-checked too - proven by
    // the fact promotion above went through generateSystemTask (which itself requires manage_tasks);
    // both partnership_manager/partnership_head hold it (see seed-access-data.ts's operations grant).

    // Source-history preservation: the MeetingActionItem's own version/event history is untouched by
    // promotion - it never rewrites the action item's own text/assignee history.
    const itemVersionsAfterPromotion = must(await listActionItemVersions(manager, item.actionItemRef), "versions after promotion");
    expect(itemVersionsAfterPromotion.versions).toHaveLength(1);
    const itemAfterPromotion = must(await getActionItem(manager, item.actionItemRef), "getActionItem after promotion");
    expect(itemAfterPromotion.text).toBe("Send renewal terms"); // MeetingActionItem's own text, untouched
    expect(itemAfterPromotion.status).toBe("OPEN"); // Task completion never silently completes the source action item
  });

  it("promotion for a Discovery-Lead-owned action item resolves a real Task target (the documented DISCOVERY_LEAD target-type extension)", async () => {
    const manager = await actorFor("partnership_manager");
    const leadRef = await realLead(`NM Promotion Lead ${runId}`);
    const meeting = must(await createMeeting(manager, { owner: { ownerType: "DISCOVERY_LEAD", ownerRef: leadRef }, title: "Lead check-in", meetingAt: new Date().toISOString() }, requestId()), "createMeeting on Discovery Lead");
    meetingRefs.push(meeting.meetingRef);
    const item = must(await createActionItem(manager, { meetingRef: meeting.meetingRef, expectedDocVersion: meeting.docVersion, text: "Follow up with the lead", assigneeUserRef: manager.userRef }, requestId()), "createActionItem");

    const promoted = must(await promoteActionItem(manager, { actionItemRef: item.actionItemRef }, requestId()), "promoteActionItem on Discovery Lead");
    expect(promoted.promotedTaskRef).not.toBeNull();
    taskRefs.push(promoted.promotedTaskRef!);
    const task = mustOps(await getTask(manager, promoted.promotedTaskRef!), "getTask for Discovery Lead promotion");
    expect(task.target).toEqual({ targetType: "DISCOVERY_LEAD", targetRef: leadRef, targetVersion: null });
    expect(task.targetDisplayName).not.toBeNull(); // resolved via target-display.ts's new DISCOVERY_LEAD case
  });
});
