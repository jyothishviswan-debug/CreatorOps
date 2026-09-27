import type { ActorContext } from "@/server/authz/types";
import { getAssignment } from "@/server/assignments/assignment-service";
import { getCampaign } from "@/server/campaigns/campaign-service";
import { getContent } from "@/server/content/content-service";
import { getLead } from "@/server/discovery/lead-service";
import type { FeatureId } from "@/server/authz/features";
import type { TargetReference, TargetType } from "@/server/operations/target-ref";
import { getPartner } from "@/server/partners/partner-service";
import { getVendor } from "@/server/vendors/vendor-service";

import { z } from "zod";

// Notes/Meetings Completion, section 3/10/11/12 of the spec: the server-authoritative owner-type
// registry. Notes/Meetings is a SHARED capability, never a top-level competing module - it never
// re-implements an owning module's own RecordScope. Instead, "can this actor see/attach to this
// owner record" is answered by calling that module's OWN already-gated single-item getter (exactly
// the composition src/server/operations/target-display.ts already established for Task/Reminder
// targets) and treating a denial/not-found from that getter as "cannot see this record".
//
// Before-state note: an exhaustive repository search (grep across src/**) found zero existing
// noteEntries/Meeting/MoM/MeetingActionItem schema or service anywhere - only the two byte-for-byte
// "Not yet built" placeholder dialogs (AssignmentNotesDialog/ContentNotesDialog). There is no dead
// historical architecture to reconcile against or migrate; docs/CREATOROPS_CONTINUITY.md already
// said so accurately before this stage, and is being replaced with the real result below.
export const OWNER_TYPES = ["DISCOVERY_LEAD", "PARTNER", "VENDOR", "CAMPAIGN", "ASSIGNMENT", "CONTENT", "PARTNER_REVIEW", "FINANCE_AGREEMENT", "OPERATIONS_TASK"] as const;
export const ownerTypeSchema = z.enum(OWNER_TYPES);
export type OwnerType = z.infer<typeof ownerTypeSchema>;

export const ownerReferenceSchema = z.object({ ownerType: ownerTypeSchema, ownerRef: z.string().min(1).max(200) }).strict();
export type OwnerReference = z.infer<typeof ownerReferenceSchema>;

// Section 3's required classification. SUPPORTED = wired end-to-end this stage (backend + a real UI
// entry point). FUTURE = deliberately NOT wired this stage (see the per-type "reasoning" string) -
// never silently half-built; a FUTURE owner type is rejected up front by every service entry point,
// never accepted and then silently mishandled.
export type OwnerTypeClassification = "SUPPORTED" | "FUTURE";

export type OwnerTypeDef = {
  ownerType: OwnerType;
  label: string;
  classification: OwnerTypeClassification;
  // The FeatureId whose FeatureAccess/ActionPermission gates Notes/Meetings actions on this owner
  // type (section 13's chosen design: compose the OWNING entity's own feature rather than a new
  // top-level "notes"/"meetings" FeatureId - see notes-meetings-gate.ts).
  feature: FeatureId | null;
  reasoning: string;
};

export const OWNER_TYPE_REGISTRY: Record<OwnerType, OwnerTypeDef> = {
  DISCOVERY_LEAD: { ownerType: "DISCOVERY_LEAD", label: "Discovery Lead", classification: "SUPPORTED", feature: "discovery", reasoning: "Prioritized by spec section 3; getLead is a real gated single-item getter." },
  PARTNER: { ownerType: "PARTNER", label: "Partner", classification: "SUPPORTED", feature: "partners", reasoning: "Prioritized by spec section 3; getPartner is a real gated single-item getter." },
  VENDOR: { ownerType: "VENDOR", label: "Vendor", classification: "SUPPORTED", feature: "vendors", reasoning: "Prioritized by spec section 3; getVendor is a real gated single-item getter." },
  CAMPAIGN: { ownerType: "CAMPAIGN", label: "Campaign", classification: "SUPPORTED", feature: "campaigns", reasoning: "Prioritized by spec section 3; getCampaign is a real gated single-item getter." },
  ASSIGNMENT: { ownerType: "ASSIGNMENT", label: "Assignment", classification: "SUPPORTED", feature: "assignments", reasoning: "Prioritized by spec section 3; getAssignment is a real gated single-item getter; also the exact golden-master frozen 'Notes & meetings' tab-strip slot this stage replaces." },
  CONTENT: { ownerType: "CONTENT", label: "Content", classification: "SUPPORTED", feature: "content", reasoning: "Prioritized by spec section 3; getContent is a real gated single-item getter; also a frozen 'Notes & meetings' tab-strip slot this stage replaces." },
  // Section 3: "also inspect whether Partner Review, Finance Agreement, and Operations Task should
  // expose Notes/Meetings." Judgment call (documented in the completion report): left FUTURE this
  // stage. Each already carries its own append-only event/history trail covering "who changed what,
  // when" for its own governed content, none is in the spec's prioritized six, and each would need
  // its own DTO-shape review (getAgreementDetail/getPartnerReview take an optional `version` and
  // return a versioned detail shape target-display.ts itself does not resolve either - both already
  // fall through to null there today; getTask's DTO carries no owner-scope-independent notion of
  // "attach a note here" without also deciding whether a Note should pin to a specific
  // Agreement/Review *version* or float across all of them, a real design decision out of this
  // stage's time budget). The registry lists them so a later stage can wire them additively; no
  // service in this module accepts them yet.
  PARTNER_REVIEW: { ownerType: "PARTNER_REVIEW", label: "Partner Review", classification: "FUTURE", feature: null, reasoning: "Versioned detail shape (pin-to-version vs float) needs its own design pass; not in spec's prioritized six." },
  FINANCE_AGREEMENT: { ownerType: "FINANCE_AGREEMENT", label: "Finance Agreement", classification: "FUTURE", feature: null, reasoning: "Versioned detail shape (pin-to-version vs float) needs its own design pass; not in spec's prioritized six." },
  OPERATIONS_TASK: { ownerType: "OPERATIONS_TASK", label: "Operations Task", classification: "FUTURE", feature: null, reasoning: "A Task already carries its own notes/events; attaching a second, competing Notes/Meetings context to a Task risks the exact 'second task system' confusion section 19 warns against. Not in spec's prioritized six." },
};

export function isSupportedOwnerType(ownerType: string): ownerType is OwnerType {
  const def = OWNER_TYPE_REGISTRY[ownerType as OwnerType];
  return def !== undefined && def.classification === "SUPPORTED";
}

export type LoadedOwner = { ownerType: OwnerType; ownerRef: string; displayName: string | null };
export type LoadOwnerResult = { ok: true; owner: LoadedOwner } | { ok: false; reason: "not_supported" | "not_found" };

// The ONE place that composes each owning module's own gated getter. A denial or not-found from
// that module's own getter is treated as "this actor cannot see this owner record" - never
// re-implemented, never bypassed. Mirrors target-display.ts's resolveOne exactly, but also used as
// an AUTHORIZATION gate here (not just a display-name lookup): a null/`ok:false` result means the
// caller must return the same neutral not-found every other module's own scope-denial returns.
export async function loadAuthorizedOwner(actor: ActorContext | null, ownerType: string, ownerRef: string): Promise<LoadOwnerResult> {
  if (!isSupportedOwnerType(ownerType)) return { ok: false, reason: "not_supported" };
  try {
    switch (ownerType) {
      case "DISCOVERY_LEAD": {
        const r = await getLead(actor, ownerRef);
        return r.ok ? { ok: true, owner: { ownerType, ownerRef, displayName: r.data.displayName } } : { ok: false, reason: "not_found" };
      }
      case "PARTNER": {
        const r = await getPartner(actor, ownerRef);
        return r.ok ? { ok: true, owner: { ownerType, ownerRef, displayName: r.data.displayName } } : { ok: false, reason: "not_found" };
      }
      case "VENDOR": {
        const r = await getVendor(actor, ownerRef);
        return r.ok ? { ok: true, owner: { ownerType, ownerRef, displayName: r.data.displayName } } : { ok: false, reason: "not_found" };
      }
      case "CAMPAIGN": {
        const r = await getCampaign(actor, ownerRef);
        return r.ok ? { ok: true, owner: { ownerType, ownerRef, displayName: r.data.name } } : { ok: false, reason: "not_found" };
      }
      case "ASSIGNMENT": {
        const r = await getAssignment(actor, ownerRef);
        return r.ok ? { ok: true, owner: { ownerType, ownerRef, displayName: [r.data.partnerDisplayName, r.data.campaignName].filter(Boolean).join(" · ") || null } } : { ok: false, reason: "not_found" };
      }
      case "CONTENT": {
        const r = await getContent(actor, ownerRef);
        return r.ok ? { ok: true, owner: { ownerType, ownerRef, displayName: [r.data.partnerDisplayName, r.data.campaignName].filter(Boolean).join(" · ") || null } } : { ok: false, reason: "not_found" };
      }
      default:
        return { ok: false, reason: "not_supported" };
    }
  } catch {
    return { ok: false, reason: "not_found" };
  }
}

// The mapping from a Notes/Meetings owner to the Operations TargetReference a promoted Task points
// at - reuses the SAME opaque ref, never a second id scheme. Returns null for a FUTURE owner type
// (promotion is refused up front rather than producing an unresolvable target).
const OWNER_TO_TARGET_TYPE: Partial<Record<OwnerType, TargetType>> = {
  DISCOVERY_LEAD: "DISCOVERY_LEAD",
  PARTNER: "PARTNER",
  VENDOR: "VENDOR",
  CAMPAIGN: "CAMPAIGN",
  ASSIGNMENT: "ASSIGNMENT",
  CONTENT: "CONTENT",
};

export function ownerToOperationsTarget(owner: OwnerReference): TargetReference | null {
  const targetType = OWNER_TO_TARGET_TYPE[owner.ownerType];
  if (!targetType) return null;
  return { targetType, targetRef: owner.ownerRef, targetVersion: null };
}
