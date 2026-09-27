import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import type { ActorContext } from "@/server/authz/types";

import type { OwnerType } from "./owner-registry";
import { OWNER_TYPE_REGISTRY } from "./owner-registry";

// Notes/Meetings Completion: a small server-side helper each owner detail PAGE (Assignment/Content/
// Partner/Vendor/Campaign/Discovery Lead) calls once to decide which Notes/Meetings write controls to
// render - mirrors the existing `canOpenPartnerReviews`/`canOpenFinance` precomputed-boolean-prop
// pattern already used by PartnerDetail.tsx. This is a UI convenience ONLY: every write still
// re-authorizes for real server-side (notes-meetings-gate.ts) regardless of what this returns.
export type NotesMeetingsUiPermissions = { canViewNotesMeetings: boolean; canManageNotes: boolean; canManageMeetings: boolean; canPromote: boolean };

export async function computeNotesMeetingsUiPermissions(actor: ActorContext | null, ownerType: OwnerType): Promise<NotesMeetingsUiPermissions> {
  const deny: NotesMeetingsUiPermissions = { canViewNotesMeetings: false, canManageNotes: false, canManageMeetings: false, canPromote: false };
  if (!actor) return deny;
  const feature = OWNER_TYPE_REGISTRY[ownerType].feature;
  if (!feature) return deny;
  const canView = await canAccessFeature(actor, feature);
  if (!canView) return deny;
  const [canManageNotes, canManageMeetings, canPromote] = await Promise.all([canPerformAction(actor, feature, "manage_notes"), canPerformAction(actor, feature, "manage_meetings"), canPerformAction(actor, feature, "promote_action_item")]);
  return { canViewNotesMeetings: true, canManageNotes, canManageMeetings, canPromote };
}
