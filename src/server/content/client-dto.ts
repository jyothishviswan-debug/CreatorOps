import { getUserDoc } from "@/server/authz/firestore";
import { getCampaignDocByRef, getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import { getPartnerDocByRef, getPartnerDocsByRefs } from "@/server/partners/firestore";
import type { ContentDoc, ContentFulfillmentKind, ContentLinkRow, ContentStatus, QualifyingFulfillment } from "./types";

// The only shape of a Content record ever handed to the browser - no
// Firestore doc id, no raw Firebase uid anywhere (ownerUid resolved to
// the owner's own opaque userRef, contentRef used everywhere the
// internal uid would otherwise leak - same discipline as AssignmentDto).
// Every field on contentDocSchema is represented here, plus resolved
// display context (campaignName/partnerDisplayName/ownerDisplayName) -
// additive only, mirrors AssignmentDto's own shape.
export type ContentDto = {
  contentRef: string;
  version: number;

  assignmentRef: string;
  campaignRef: string;
  campaignName: string | null;
  partnerRef: string;
  partnerDisplayName: string | null;

  status: ContentStatus;
  statusReason: string | null;

  currentRevisionNumber: number;
  reviewedRevisionNumber: number | null;

  currentLinks: ContentLinkRow[];
  qualifyingFulfillment: QualifyingFulfillment | null;

  dueAt: string | null;

  openedAt: string;
  firstSubmittedAt: string | null;
  lastSubmittedAt: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;

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

function projectDto(doc: ContentDoc, owner: { ref: string | null; displayName: string | null }, campaignName: string | null, partnerDisplayName: string | null): ContentDto {
  return {
    contentRef: doc.contentRef,
    version: doc.version,
    assignmentRef: doc.assignmentRef,
    campaignRef: doc.campaignRef,
    campaignName,
    partnerRef: doc.partnerRef,
    partnerDisplayName,
    status: doc.status,
    statusReason: doc.statusReason,
    currentRevisionNumber: doc.currentRevisionNumber,
    reviewedRevisionNumber: doc.reviewedRevisionNumber,
    currentLinks: doc.currentLinks,
    qualifyingFulfillment: doc.qualifyingFulfillment,
    dueAt: doc.dueAt,
    openedAt: doc.openedAt,
    firstSubmittedAt: doc.firstSubmittedAt,
    lastSubmittedAt: doc.lastSubmittedAt,
    approvedAt: doc.approvedAt,
    cancelledAt: doc.cancelledAt,
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

// Single-item path (Detail page) - a small, fixed number of direct,
// independently-authorized reads, never repeated in a list loop (Step
// 10B section 5's own allowance, mirrored here for Content).
export async function toContentDto(doc: ContentDoc): Promise<ContentDto> {
  const [owner, campaign, partner] = await Promise.all([resolveUserRefAndName(doc.ownerUid), getCampaignDocByRef(doc.campaignRef), getPartnerDocByRef(doc.partnerRef)]);

  return projectDto(doc, owner, campaign?.name ?? null, partner?.displayName ?? null);
}

// Batched, N+1-safe list path - resolves each distinct ownerUid at most
// once, and campaignName/partnerDisplayName via the bounded bulk
// getXDocsByRefs helpers (one chunked "in" query per distinct-ref family,
// never one read per row).
export async function toContentDtos(docs: ContentDoc[]): Promise<ContentDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  const campaignRefs = docs.map((d) => d.campaignRef);
  const partnerRefs = docs.map((d) => d.partnerRef);

  const [campaigns, partners] = await Promise.all([getCampaignDocsByRefs(campaignRefs), getPartnerDocsByRefs(partnerRefs)]);

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return projectDto(doc, owner, campaigns.get(doc.campaignRef)?.name ?? null, partners.get(doc.partnerRef)?.displayName ?? null);
  });
}

// Re-exported for callers that only need the fulfillment-kind literal
// type alongside the DTO (e.g. seed data, tests) without importing
// types.ts directly for it.
export type { ContentFulfillmentKind };
