import type { ActionId } from "@/server/authz/actions";
import { canAccessSensitive } from "@/server/authz/sensitive";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";

import { getActionItemHeadDoc, getMeetingHeadDoc, getNoteHeadDoc } from "./firestore";
import { loadAuthorizedOwner, OWNER_TYPE_REGISTRY, type OwnerType } from "./owner-registry";
import { NOTES_MEETINGS_SENSITIVE_CATEGORY, notesMeetingsNotFoundResult, notesMeetingsUnauthorizedResult, type ActionItemHeadDoc, type MeetingHeadDoc, type NoteHeadDoc, type NotesMeetingsErrorResult } from "./types";

// Notes/Meetings Completion (spec section 4): preserves
// Authentication -> Admission/ActiveUser -> FeatureAccess -> ActionPermission -> RecordScope ->
// SensitiveAccess -> LifecyclePreconditions, exactly like every other module's own gate. The
// distinctive step here is FeatureAccess/ActionPermission/RecordScope: rather than a dedicated
// "notes"/"meetings" FeatureId (section 13's documented design choice - see owner-registry.ts), this
// composes the OWNING entity's own already-gated getter (RecordScope, real, live) with that SAME
// owning feature's own ActionPermission (manage_notes/manage_meetings/promote_action_item, added to
// every SUPPORTED owner type's module-actions.ts entry). Missing context fails closed: a FUTURE owner
// type, an unauthorized owner, or a missing action grant are all the same neutral not-found/forbidden
// a caller cannot distinguish from "this record does not exist" (never a wildcard, never role rank).
export type NotesMeetingsAction = Extract<ActionId, "manage_notes" | "manage_meetings" | "promote_action_item">;

export type OwnerGateResult = { ok: true; ownerDisplayName: string | null; feature: NonNullable<ReturnType<typeof featureOf>> } | { ok: false; error: NotesMeetingsErrorResult };

function featureOf(ownerType: OwnerType) {
  return OWNER_TYPE_REGISTRY[ownerType].feature;
}

// The one entry point every Note/Meeting create/list call uses: authenticates, resolves+authorizes
// the owner (composition, not reimplementation), then checks the module ActionPermission on that
// owner's OWN feature.
export async function requireOwnerAccess(actor: ActorContext | null, ownerType: string, ownerRef: string, action?: NotesMeetingsAction): Promise<OwnerGateResult> {
  if (!actor) return { ok: false, error: notesMeetingsUnauthorizedResult("not_authenticated") };

  const loaded = await loadAuthorizedOwner(actor, ownerType, ownerRef);
  if (!loaded.ok) {
    // A FUTURE/unsupported owner type is a real, actionable invalid_input (never confused with a
    // real-but-inaccessible record); an unauthorized/missing owner is the neutral not_found every
    // other module's own scope denial already uses.
    if (loaded.reason === "not_supported") return { ok: false, error: notesMeetingsUnauthorizedResult("owner_denied") };
    return { ok: false, error: notesMeetingsNotFoundResult() };
  }

  const feature = featureOf(loaded.owner.ownerType);
  if (!feature) return { ok: false, error: notesMeetingsUnauthorizedResult("owner_denied") };

  const hasFeature = await canAccessFeature(actor, feature);
  if (!hasFeature) return { ok: false, error: notesMeetingsUnauthorizedResult("feature_denied") };

  if (action) {
    const hasAction = await canPerformAction(actor, feature, action);
    if (!hasAction) return { ok: false, error: notesMeetingsUnauthorizedResult("action_denied") };
  }

  return { ok: true, ownerDisplayName: loaded.owner.displayName, feature };
}

// --- Load-by-ref + re-verify-owner-scope-live (the "guessed ref never leaks" gate) -------------------
export type AuthorizedNote = { head: NoteHeadDoc; ownerDisplayName: string | null };
export type LoadNoteResult = { ok: true; authorized: AuthorizedNote } | { ok: false; error: NotesMeetingsErrorResult };

export async function loadAuthorizedNote(actor: ActorContext | null, noteRef: string, action?: NotesMeetingsAction): Promise<LoadNoteResult> {
  if (!actor) return { ok: false, error: notesMeetingsUnauthorizedResult("not_authenticated") };
  const head = await getNoteHeadDoc(noteRef);
  if (!head) return { ok: false, error: notesMeetingsNotFoundResult() };
  const gate = await requireOwnerAccess(actor, head.owner.ownerType, head.owner.ownerRef, action);
  if (!gate.ok) return { ok: false, error: gate.error.code === "not_found" ? notesMeetingsNotFoundResult() : gate.error };
  return { ok: true, authorized: { head, ownerDisplayName: gate.ownerDisplayName } };
}

export type AuthorizedMeeting = { head: MeetingHeadDoc; ownerDisplayName: string | null };
export type LoadMeetingResult = { ok: true; authorized: AuthorizedMeeting } | { ok: false; error: NotesMeetingsErrorResult };

export async function loadAuthorizedMeeting(actor: ActorContext | null, meetingRef: string, action?: NotesMeetingsAction): Promise<LoadMeetingResult> {
  if (!actor) return { ok: false, error: notesMeetingsUnauthorizedResult("not_authenticated") };
  const head = await getMeetingHeadDoc(meetingRef);
  if (!head) return { ok: false, error: notesMeetingsNotFoundResult() };
  const gate = await requireOwnerAccess(actor, head.owner.ownerType, head.owner.ownerRef, action);
  if (!gate.ok) return { ok: false, error: gate.error.code === "not_found" ? notesMeetingsNotFoundResult() : gate.error };
  return { ok: true, authorized: { head, ownerDisplayName: gate.ownerDisplayName } };
}

export type AuthorizedActionItem = { head: ActionItemHeadDoc; meeting: AuthorizedMeeting };
export type LoadActionItemResult = { ok: true; authorized: AuthorizedActionItem } | { ok: false; error: NotesMeetingsErrorResult };

// A MeetingActionItem is owned by its Meeting (spec section 2C: "distinct child/domain record owned
// by the Meeting") - it has no owner of its own, so authorizing it means authorizing the parent
// Meeting first, then checking the actionItem's own meetingRef actually matches (an action item can
// never be addressed through a different, unrelated Meeting's authorization).
export async function loadAuthorizedActionItem(actor: ActorContext | null, actionItemRef: string, action?: NotesMeetingsAction): Promise<LoadActionItemResult> {
  if (!actor) return { ok: false, error: notesMeetingsUnauthorizedResult("not_authenticated") };
  const head = await getActionItemHeadDoc(actionItemRef);
  if (!head) return { ok: false, error: notesMeetingsNotFoundResult() };
  const meeting = await loadAuthorizedMeeting(actor, head.meetingRef, action);
  if (!meeting.ok) return { ok: false, error: meeting.error };
  return { ok: true, authorized: { head, meeting: meeting.authorized } };
}

// --- Sensitivity (spec section 5) -------------------------------------------------------------------
export async function canViewSensitiveNotesMeetings(actor: ActorContext): Promise<boolean> {
  return canAccessSensitive(actor, NOTES_MEETINGS_SENSITIVE_CATEGORY);
}
