import { getUserDoc } from "@/server/authz/firestore";
import { getCampaignDocByRef, getCampaignDocsByRefs } from "@/server/campaigns/firestore";
import { getPartnerAccountDocByRef, getPartnerAccountDocsByRefs, getPartnerDocByRef, getPartnerDocsByRefs } from "@/server/partners/firestore";
import type {
  ContentDoc,
  ContentStatus,
  ContentFulfillmentKind,
  PublicationEvidenceItem,
  QualifyingFulfillment,
  ReviewPolicy,
} from "./types";

// The only shape of a Content record ever handed to the browser - no
// Firestore doc id, no raw Firebase uid anywhere (ownerUid resolved to
// the owner's own opaque userRef, contentRef used everywhere the
// internal uid would otherwise leak - same discipline as AssignmentDto).
// Every field on contentDocSchema is represented here, plus resolved
// display context (campaignName/partnerDisplayName/partnerAccountLabel/
// ownerDisplayName) - additive only, mirrors AssignmentDto's own shape.
export type ContentDto = {
  contentRef: string;
  version: number;

  assignmentRef: string;
  campaignRef: string;
  campaignName: string | null;
  partnerRef: string;
  partnerDisplayName: string | null;
  partnerAccountRef: string | null;
  partnerAccountLabel: string | null;

  platform: string;
  contentType: string;
  title: string | null;

  status: ContentStatus;
  statusReason: string | null;
  reviewPolicy: ReviewPolicy;

  currentVersion: number;
  lastSubmittedVersion: number | null;

  publicationEvidence: PublicationEvidenceItem[];
  qualifyingFulfillment: QualifyingFulfillment | null;

  requiredSlotIndex: number | null;
  supersedesContentRef: string | null;

  dueAt: string | null;

  productionStartedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  completedAt: string | null;
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

function projectDto(
  doc: ContentDoc,
  owner: { ref: string | null; displayName: string | null },
  campaignName: string | null,
  partnerDisplayName: string | null,
  partnerAccountLabel: string | null,
): ContentDto {
  return {
    contentRef: doc.contentRef,
    version: doc.version,
    assignmentRef: doc.assignmentRef,
    campaignRef: doc.campaignRef,
    campaignName,
    partnerRef: doc.partnerRef,
    partnerDisplayName,
    partnerAccountRef: doc.partnerAccountRef,
    partnerAccountLabel,
    platform: doc.platform,
    contentType: doc.contentType,
    title: doc.title,
    status: doc.status,
    statusReason: doc.statusReason,
    reviewPolicy: doc.reviewPolicy,
    currentVersion: doc.currentVersion,
    lastSubmittedVersion: doc.lastSubmittedVersion,
    publicationEvidence: doc.publicationEvidence,
    qualifyingFulfillment: doc.qualifyingFulfillment,
    requiredSlotIndex: doc.requiredSlotIndex,
    supersedesContentRef: doc.supersedesContentRef,
    dueAt: doc.dueAt,
    productionStartedAt: doc.productionStartedAt,
    submittedAt: doc.submittedAt,
    approvedAt: doc.approvedAt,
    postedAt: doc.postedAt,
    completedAt: doc.completedAt,
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
  const [owner, campaign, partner, account] = await Promise.all([
    resolveUserRefAndName(doc.ownerUid),
    getCampaignDocByRef(doc.campaignRef),
    getPartnerDocByRef(doc.partnerRef),
    doc.partnerAccountRef ? getPartnerAccountDocByRef(doc.partnerAccountRef) : Promise.resolve(null),
  ]);

  return projectDto(doc, owner, campaign?.name ?? null, partner?.displayName ?? null, account?.displayName ?? null);
}

// Batched, N+1-safe list path - resolves each distinct ownerUid at most
// once, and campaignName/partnerDisplayName/partnerAccountLabel via the
// bounded bulk getXDocsByRefs helpers (one chunked "in" query per
// distinct-ref family, never one read per row).
export async function toContentDtos(docs: ContentDoc[]): Promise<ContentDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  const campaignRefs = docs.map((d) => d.campaignRef);
  const partnerRefs = docs.map((d) => d.partnerRef);
  const partnerAccountRefs = docs.map((d) => d.partnerAccountRef).filter((ref): ref is string => Boolean(ref));

  const [campaigns, partners, accounts] = await Promise.all([
    getCampaignDocsByRefs(campaignRefs),
    getPartnerDocsByRefs(partnerRefs),
    getPartnerAccountDocsByRefs(partnerAccountRefs),
  ]);

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return projectDto(
      doc,
      owner,
      campaigns.get(doc.campaignRef)?.name ?? null,
      partners.get(doc.partnerRef)?.displayName ?? null,
      doc.partnerAccountRef ? (accounts.get(doc.partnerAccountRef)?.displayName ?? null) : null,
    );
  });
}

// Re-exported for callers that only need the fulfillment-kind literal
// type alongside the DTO (e.g. seed data, tests) without importing
// types.ts directly for it.
export type { ContentFulfillmentKind };
