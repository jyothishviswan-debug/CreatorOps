import { getUserDoc } from "@/server/authz/firestore";
import { getCampaignDocByRef, getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import type { CampaignResource } from "@/server/campaigns/types";
import { getPartnerAccountDocByRef, getPartnerAccountDocsByRefs, getPartnerDocByRef, getPartnerDocsByRefs } from "@/server/partners/firestore";
import { getVendorDocByRef, getVendorDocsByRefs } from "@/server/vendors/firestore";
import type { AssignmentBrief, AssignmentDoc, AssignmentStatus } from "./types";

// The only shape of an Assignment ever handed to the browser - no
// Firestore doc id, no raw Firebase uid anywhere (ownerUid resolved to
// the owner's own opaque userRef, same pattern as CampaignDto).
//
// Step 10B: campaignName/partnerDisplayName/partnerAccountLabels are
// bounded, safe display context (Step 10B section 5's own requirement -
// "do not expose raw refs as normal UI labels") - additive only, nothing
// existing removed/renamed. campaignRef/partnerRef/partnerAccountRefs
// stay present too, since some callers (mutation forms, picker state)
// still need the opaque refs themselves.
export type AssignmentDto = {
  assignmentRef: string;
  version: number;
  campaignRef: string;
  campaignName: string | null;
  // Finding #38: the owning Campaign's own current Resources (LINK/UPLOAD/TEXT), read-only -
  // reused directly by the WhatsApp share-message builder (whatsapp.ts) so it never needs a
  // second fetch. Already exposed verbatim on CampaignDto itself (same DTO-boundary decision,
  // not a new exposure); each type's own canonical/safe URL field, never an internal locator.
  campaignResources: CampaignResource[];
  partnerRef: string;
  partnerDisplayName: string | null;
  partnerAccountRefs: string[];
  partnerAccountLabels: string[];
  // Finding #40: read-only provenance - which Vendor (if any) this Assignment's Partner was routed
  // through at creation. Never the assignee (that is always partnerRef/partnerDisplayName above).
  routedThroughVendorRef: string | null;
  routedThroughVendorDisplayName: string | null;
  status: AssignmentStatus;
  statusReason: string | null;
  brief: AssignmentBrief;
  regionIds: string[];
  ownerRef: string | null;
  ownerDisplayName: string | null;
  teamIds: string[];
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

async function resolveUserRefAndName(uid: string | null): Promise<{ ref: string | null; displayName: string | null }> {
  if (!uid) return { ref: null, displayName: null };
  const doc = await getUserDoc(uid);
  return { ref: doc?.userRef ?? null, displayName: doc?.displayName ?? null };
}

// Single-item path (Detail page) - a small, fixed number of direct,
// independently-authorized reads, never repeated in a list loop, so the
// ordinary per-field accessors are fine here (Step 10B section 5's own
// allowance) rather than the bulk-chunked helpers the list path below
// uses.
export async function toAssignmentDto(doc: AssignmentDoc): Promise<AssignmentDto> {
  const [owner, campaign, partner, accounts, routedThroughVendor] = await Promise.all([
    resolveUserRefAndName(doc.ownerUid),
    getCampaignDocByRef(doc.campaignRef),
    getPartnerDocByRef(doc.partnerRef),
    Promise.all(doc.partnerAccountRefs.map((ref) => getPartnerAccountDocByRef(ref))),
    doc.routedThroughVendorRef ? getVendorDocByRef(doc.routedThroughVendorRef) : Promise.resolve(null),
  ]);

  return {
    assignmentRef: doc.assignmentRef,
    version: doc.version,
    campaignRef: doc.campaignRef,
    campaignName: campaign?.name ?? null,
    campaignResources: campaign?.resources ?? [],
    partnerRef: doc.partnerRef,
    partnerDisplayName: partner?.displayName ?? null,
    partnerAccountRefs: doc.partnerAccountRefs,
    partnerAccountLabels: accounts.map((a) => a?.displayName).filter((label): label is string => Boolean(label)),
    routedThroughVendorRef: doc.routedThroughVendorRef,
    routedThroughVendorDisplayName: routedThroughVendor?.displayName ?? null,
    status: doc.status,
    statusReason: doc.statusReason,
    brief: doc.brief,
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

// Batched, N+1-safe list path - resolves each distinct ownerUid at most
// once (pre-existing pattern, unchanged), and resolves campaignName/
// partnerDisplayName/partnerAccountLabels via the new BOUNDED BULK
// getXDocsByRefs helpers (one chunked "in" query per distinct-ref family,
// never one read per row - Step 10B's own explicit correction over a
// naive per-ref Promise.all).
export async function toAssignmentDtos(docs: AssignmentDoc[]): Promise<AssignmentDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  const campaignRefs = docs.map((d) => d.campaignRef);
  const partnerRefs = docs.map((d) => d.partnerRef);
  const partnerAccountRefs = docs.flatMap((d) => d.partnerAccountRefs);
  const vendorRefs = docs.map((d) => d.routedThroughVendorRef).filter((ref): ref is string => Boolean(ref));

  const [campaigns, partners, accounts, vendors] = await Promise.all([
    getCampaignDocsByRefs(campaignRefs),
    getPartnerDocsByRefs(partnerRefs),
    getPartnerAccountDocsByRefs(partnerAccountRefs),
    getVendorDocsByRefs(vendorRefs),
  ]);

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return {
      assignmentRef: doc.assignmentRef,
      version: doc.version,
      campaignRef: doc.campaignRef,
      campaignName: campaigns.get(doc.campaignRef)?.name ?? null,
      campaignResources: campaigns.get(doc.campaignRef)?.resources ?? [],
      partnerRef: doc.partnerRef,
      partnerDisplayName: partners.get(doc.partnerRef)?.displayName ?? null,
      partnerAccountRefs: doc.partnerAccountRefs,
      partnerAccountLabels: doc.partnerAccountRefs.map((ref) => accounts.get(ref)?.displayName).filter((label): label is string => Boolean(label)),
      routedThroughVendorRef: doc.routedThroughVendorRef,
      routedThroughVendorDisplayName: doc.routedThroughVendorRef ? (vendors.get(doc.routedThroughVendorRef)?.displayName ?? null) : null,
      status: doc.status,
      statusReason: doc.statusReason,
      brief: doc.brief,
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
