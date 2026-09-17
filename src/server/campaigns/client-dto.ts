import { getUserDoc } from "@/server/authz/firestore";
import type { CampaignCriteria, CampaignDoc, CampaignResource, CampaignStatus, ReviewPolicy } from "./types";

// The only shape of a Campaign ever handed to the browser - no Firestore
// doc id, no raw Firebase uid anywhere (ownerUid resolved to the owner's
// own opaque userRef, same pattern as Vendors' VendorDto).
export type CampaignDto = {
  campaignRef: string;
  version: number;
  name: string;
  objective: string;
  status: CampaignStatus;
  statusReason: string | null;
  platforms: CampaignDoc["platforms"];
  startDate: string;
  endDate: string;
  regionIds: string[];
  ownerRef: string | null;
  ownerDisplayName: string | null;
  teamIds: string[];
  criteria: CampaignCriteria;
  resources: CampaignResource[];
  defaultReviewPolicy: ReviewPolicy;
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

export async function toCampaignDto(doc: CampaignDoc): Promise<CampaignDto> {
  const owner = await resolveUserRefAndName(doc.ownerUid);
  return {
    campaignRef: doc.campaignRef,
    version: doc.version,
    name: doc.name,
    objective: doc.objective,
    status: doc.status,
    statusReason: doc.statusReason,
    platforms: doc.platforms,
    startDate: doc.startDate,
    endDate: doc.endDate,
    regionIds: doc.regionIds,
    ownerRef: owner.ref,
    ownerDisplayName: owner.displayName,
    teamIds: doc.teamIds,
    criteria: doc.criteria,
    resources: doc.resources,
    defaultReviewPolicy: doc.defaultReviewPolicy,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
    updatedAt: doc.updatedAt,
    updatedByUserRef: doc.updatedByUserRef,
  };
}

// Batched, N+1-safe - resolves each distinct ownerUid at most once
// regardless of list size (used by list endpoints; toCampaignDto alone is
// fine for a single get).
export async function toCampaignDtos(docs: CampaignDoc[]): Promise<CampaignDto[]> {
  const uniqueOwnerUids = [...new Set(docs.map((d) => d.ownerUid).filter((uid): uid is string => Boolean(uid)))];
  const owners = new Map(await Promise.all(uniqueOwnerUids.map(async (uid) => [uid, await resolveUserRefAndName(uid)] as const)));

  return docs.map((doc) => {
    const owner = doc.ownerUid ? (owners.get(doc.ownerUid) ?? { ref: null, displayName: null }) : { ref: null, displayName: null };
    return {
      campaignRef: doc.campaignRef,
      version: doc.version,
      name: doc.name,
      objective: doc.objective,
      status: doc.status,
      statusReason: doc.statusReason,
      platforms: doc.platforms,
      startDate: doc.startDate,
      endDate: doc.endDate,
      regionIds: doc.regionIds,
      ownerRef: owner.ref,
      ownerDisplayName: owner.displayName,
      teamIds: doc.teamIds,
      criteria: doc.criteria,
      resources: doc.resources,
      defaultReviewPolicy: doc.defaultReviewPolicy,
      createdAt: doc.createdAt,
      createdByUserRef: doc.createdByUserRef,
      updatedAt: doc.updatedAt,
      updatedByUserRef: doc.updatedByUserRef,
    };
  });
}
