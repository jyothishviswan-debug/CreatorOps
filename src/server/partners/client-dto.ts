import { getUserDoc } from "@/server/authz/firestore";
import type { PartnerAccountDoc, PartnerDoc, PartnerStatus, TargetAudience } from "./types";

// The safe subset of sourceDiscovery worth showing the browser - already
// entirely non-restricted fields (see partnerDocSchema's own comment),
// so this is a narrow passthrough, not a redaction.
export type PartnerSourceDiscoveryDto = NonNullable<PartnerDoc["sourceDiscovery"]>;

// The only shape of a Partner ever handed to the browser - no Firestore
// doc id, no raw Firebase uid anywhere (ownerUid resolved to the owner's
// own opaque userRef, same pattern as Discovery's LeadDto). Restricted
// financial identity is never included here at all - see
// restricted-identity-service.ts's own, separately-gated DTO.
export type PartnerDto = {
  partnerRef: string;
  version: number;
  displayName: string;
  legalName: string | null;
  status: PartnerStatus;
  previousStatus: PartnerStatus | null;
  statusReason: string | null;
  regionIds: string[];
  languageIds: string[];
  categoryIds: string[];
  tier: string | null;
  priority: string | null;
  targetAudience: TargetAudience[];
  email: string | null;
  phone: string | null;
  ownerRef: string | null;
  ownerDisplayName: string | null;
  teamIds: string[];
  originLeadRefs: string[];
  sourceDiscovery: PartnerSourceDiscoveryDto | null;
  pendingPartnerAccountSetup: boolean;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

// A referenced uid (owner) can, in principle, no longer resolve - fail
// soft here (nulls) rather than throwing, since this is a display
// concern, not an authorization decision.
async function resolveUserRefAndName(uid: string | null): Promise<{ ref: string | null; displayName: string | null }> {
  if (!uid) return { ref: null, displayName: null };
  const doc = await getUserDoc(uid);
  return { ref: doc?.userRef ?? null, displayName: doc?.displayName ?? null };
}

export async function toPartnerDto(doc: PartnerDoc): Promise<PartnerDto> {
  const owner = await resolveUserRefAndName(doc.ownerUid);
  return {
    partnerRef: doc.partnerRef,
    version: doc.version,
    displayName: doc.displayName,
    legalName: doc.legalName,
    status: doc.status,
    previousStatus: doc.previousStatus,
    statusReason: doc.statusReason,
    regionIds: doc.regionIds,
    languageIds: doc.languageIds,
    categoryIds: doc.categoryIds,
    tier: doc.tier,
    priority: doc.priority,
    targetAudience: doc.targetAudience,
    email: doc.email,
    phone: doc.phone,
    ownerRef: owner.ref,
    ownerDisplayName: owner.displayName,
    teamIds: doc.teamIds,
    originLeadRefs: doc.originLeadRefs,
    sourceDiscovery: doc.sourceDiscovery,
    pendingPartnerAccountSetup: doc.pendingPartnerAccountSetup,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
  };
}

// Batched, N+1-safe - resolves each distinct ownerUid at most once
// regardless of list size (used by list endpoints; toPartnerDto alone is
// fine for a single get).
export async function toPartnerDtos(docs: PartnerDoc[]): Promise<PartnerDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return {
      partnerRef: doc.partnerRef,
      version: doc.version,
      displayName: doc.displayName,
      legalName: doc.legalName,
      status: doc.status,
      previousStatus: doc.previousStatus,
      statusReason: doc.statusReason,
      regionIds: doc.regionIds,
      languageIds: doc.languageIds,
      categoryIds: doc.categoryIds,
      tier: doc.tier,
      priority: doc.priority,
      targetAudience: doc.targetAudience,
      email: doc.email,
      phone: doc.phone,
      ownerRef: owner.ref,
      ownerDisplayName: owner.displayName,
      teamIds: doc.teamIds,
      originLeadRefs: doc.originLeadRefs,
      sourceDiscovery: doc.sourceDiscovery,
      pendingPartnerAccountSetup: doc.pendingPartnerAccountSetup,
      createdAt: doc.createdAt,
      createdByUserRef: doc.createdByUserRef,
      updatedAt: doc.updatedAt,
      updatedByUserRef: doc.updatedByUserRef,
    };
  });
}

// Partner Account DTO - already fully opaque-ref-shaped in its stored
// form (no raw uid to resolve), so this is a narrow passthrough that
// exists mainly to keep "what the browser can see" an explicit, typed
// contract rather than the raw Firestore doc shape.
export type PartnerAccountDto = Omit<PartnerAccountDoc, "uid">;

export function toPartnerAccountDto(doc: PartnerAccountDoc): PartnerAccountDto {
  const rest: Partial<PartnerAccountDoc> = { ...doc };
  delete rest.uid;
  return rest as PartnerAccountDto;
}

// A safe, minimal Partner label for embedding inside rows returned from
// the VENDOR side (see vendor-partner-link-service.ts's listLinksForVendor) -
// mirrors Vendors' own VendorSafeLabelDto/toVendorSafeLabelDto exactly, in
// the reverse direction. Deliberately never the full PartnerDto, which
// would require Partner-side scope the Vendor-scoped actor managing that
// link may not hold - Step 8A section 7's scope-escalation-bridge rule
// applies symmetrically in both directions.
export type PartnerSafeLabelDto = { partnerRef: string; displayName: string; regionIds: string[] };

export function toPartnerSafeLabelDto(doc: PartnerDoc): PartnerSafeLabelDto {
  return { partnerRef: doc.partnerRef, displayName: doc.displayName, regionIds: doc.regionIds };
}
