import { getUserDoc } from "@/server/authz/firestore";
import type { VendorDoc, VendorPartnerLinkDoc, VendorStatus, VendorType } from "./types";

// The only shape of a Vendor ever handed to the browser - no Firestore
// doc id, no raw Firebase uid anywhere (ownerUid resolved to the owner's
// own opaque userRef, same pattern as Partners' PartnerDto). Restricted
// financial identity is never included here at all - see
// restricted-identity-service.ts's own, separately-gated DTO.
export type VendorDto = {
  vendorRef: string;
  version: number;
  displayName: string;
  legalName: string | null;
  vendorType: VendorType;
  status: VendorStatus;
  previousStatus: VendorStatus | null;
  statusReason: string | null;
  email: string | null;
  phone: string | null;
  businessReferences: { label: string; value: string }[];
  regionIds: string[];
  ownerRef: string | null;
  ownerDisplayName: string | null;
  teamIds: string[];
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

export async function toVendorDto(doc: VendorDoc): Promise<VendorDto> {
  const owner = await resolveUserRefAndName(doc.ownerUid);
  return {
    vendorRef: doc.vendorRef,
    version: doc.version,
    displayName: doc.displayName,
    legalName: doc.legalName,
    vendorType: doc.vendorType,
    status: doc.status,
    previousStatus: doc.previousStatus,
    statusReason: doc.statusReason,
    email: doc.email,
    phone: doc.phone,
    businessReferences: doc.businessReferences,
    regionIds: doc.regionIds,
    ownerRef: owner.ref,
    ownerDisplayName: owner.displayName,
    teamIds: doc.teamIds,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
  };
}

// Batched, N+1-safe - resolves each distinct ownerUid at most once
// regardless of list size (used by list endpoints; toVendorDto alone is
// fine for a single get).
export async function toVendorDtos(docs: VendorDoc[]): Promise<VendorDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return {
      vendorRef: doc.vendorRef,
      version: doc.version,
      displayName: doc.displayName,
      legalName: doc.legalName,
      vendorType: doc.vendorType,
      status: doc.status,
      previousStatus: doc.previousStatus,
      statusReason: doc.statusReason,
      email: doc.email,
      phone: doc.phone,
      businessReferences: doc.businessReferences,
      regionIds: doc.regionIds,
      ownerRef: owner.ref,
      ownerDisplayName: owner.displayName,
      teamIds: doc.teamIds,
      createdAt: doc.createdAt,
      createdByUserRef: doc.createdByUserRef,
      updatedAt: doc.updatedAt,
      updatedByUserRef: doc.updatedByUserRef,
    };
  });
}

// Vendor<->Partner link DTO - already fully opaque-ref-shaped in its
// stored form (no raw uid to resolve), so this is a narrow passthrough
// that exists mainly to keep "what the browser can see" an explicit,
// typed contract rather than the raw Firestore doc shape.
export type VendorPartnerLinkDto = Omit<VendorPartnerLinkDoc, "uid">;

export function toVendorPartnerLinkDto(doc: VendorPartnerLinkDoc): VendorPartnerLinkDto {
  const rest: Partial<VendorPartnerLinkDoc> = { ...doc };
  delete rest.uid;
  return rest as VendorPartnerLinkDto;
}

// A safe, minimal Vendor label for embedding inside link rows returned
// from the PARTNER side (see vendor-partner-link-service.ts's
// listLinksForPartner) - deliberately never the full VendorDto, which
// would require Vendor-side scope. Only enough to show a human a
// meaningful row: who the Vendor is, its type, and its current status.
export type VendorSafeLabelDto = { vendorRef: string; displayName: string; vendorType: VendorType; status: VendorStatus };

export function toVendorSafeLabelDto(doc: VendorDoc): VendorSafeLabelDto {
  return { vendorRef: doc.vendorRef, displayName: doc.displayName, vendorType: doc.vendorType, status: doc.status };
}

// canOpenVendor: Step 8B.1 REVISED section 8 - server-derived from this
// actor's OWN effective direct Vendor access/scope for this specific
// linked Vendor (never role/grant/scope internals), computed once here
// in listVendorLinksForPartner rather than a per-row client-side probe.
// The direct Vendor detail endpoint still independently re-authorizes
// when opened - this field only controls whether "Open Vendor" renders.
export type PartnerVendorLinkDto = VendorPartnerLinkDto & { vendor: VendorSafeLabelDto; canOpenVendor: boolean };

// The Vendor-side mirror of PartnerVendorLinkDto - a link row plus a safe
// minimal Partner label (see @/server/partners/client-dto.ts's
// PartnerSafeLabelDto), used by listLinksForVendor so the Vendor's own
// Relationships tab can show "linked Partner" without requiring the
// Vendor-scoped actor to also hold Partner-side scope for that Partner.
export type VendorPartnerLinkWithPartnerDto = VendorPartnerLinkDto & { partner: { partnerRef: string; displayName: string; regionIds: string[] } };
